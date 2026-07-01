/**
 * qcp chat — interactive CLI assistant
 *
 * A persistent REPL where users ask questions about their database
 * in plain English. Each answer builds on the schema context.
 */

import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import chalk from "chalk";
import inquirer from "inquirer";
import ora from "ora";
import { v7 as uuidv7 } from "uuid";
import type { QcpSupervisorAgent } from "@/agents/supervisor-agent.js";
import {
	getActiveDatabaseConnection,
	loadConfig,
	withActiveDatabaseConnection,
} from "@/config/index.js";
import { log } from "@/logger/index.js";
import {
	printApprovalWarning,
	printBanner,
	printError,
	printInfo,
	printPromptViolation,
	printSection,
} from "@/output/index.js";
import {
	type PackageGroup,
	providerPackageGroup,
} from "@/packages/lazy-packages.js";
import { ensurePackageGroups } from "@/packages/runtime.js";
import {
	classifyPromptViolation,
	sanitizeSensitiveData,
} from "@/safety/index.js";
import { loadSchemaForConnection } from "@/schema/index.js";
import {
	initTelemetry,
	shutdownTelemetry,
	trackActive,
	trackError,
	trackHumanApproval,
	trackQuery,
	trackQueryRejected,
} from "@/telemetry/index.js";
import type { ApprovalReason, DatabaseSchema } from "@/types/index.js";

const HELP_COMMANDS = new Set(["/help", "?", "help"]);
const EXIT_COMMANDS = new Set([
	"/exit",
	"/quit",
	"exit",
	"quit",
	"q",
	":q",
	".exit",
]);
const CLEAR_COMMANDS = new Set(["/clear", "clear"]);
const SCHEMA_COMMANDS = new Set(["/schema", "/tables", "tables"]);

interface ChatSession {
	connectionName: string;
	schema: DatabaseSchema;
	supervisor: QcpSupervisorAgent;
	questionCount: number;
	startTime: number;
}

export interface ChatOptions {
	noConfirm?: boolean;
}

// ─── Main REPL loop ────────────────────────────────────────────────────────────

export async function chatCommand(options: ChatOptions = {}): Promise<void> {
	const config = loadConfig();
	initTelemetry(config);
	trackActive();

	const connection = getActiveDatabaseConnection(config);
	if (!connection) {
		printError("No database connection configured.", "Run: qcp connect");
		await shutdownTelemetry();
		process.exit(1);
	}
	const activeConfig = withActiveDatabaseConnection(config, connection);

	// ── Startup ────────────────────────────────────────────────────────────────
	printBanner();

	const schemaSpinner = ora("Loading schema...").start();
	let schema: DatabaseSchema;
	try {
		schema = loadSchemaForConnection(connection).schema;
		schemaSpinner.succeed(
			`Schema loaded · ${connection.name} · ${schema.databaseName} · ${schema.tableCount} tables`,
		);
	} catch (_: unknown) {
		schemaSpinner.fail("Schema not found. Run: qcp schema scan");
		await shutdownTelemetry();
		process.exit(1);
	}

	// ── Welcome ────────────────────────────────────────────────────────────────
	console.log();
	console.log(
		chalk.bold("  ◆ Query Companion") + chalk.dim(" — Interactive Mode"),
	);
	console.log(
		chalk.dim(`  Database: `) +
			chalk.white(`${connection.name} (${schema.databaseName})`) +
			chalk.dim(` · Provider: `) +
			chalk.white(`${activeConfig.provider}/${activeConfig.model}`),
	);
	console.log(
		chalk.dim("  Type your question, or ") +
			chalk.cyan("/help") +
			chalk.dim(" for commands. ") +
			chalk.cyan("/exit") +
			chalk.dim(" to quit."),
	);
	console.log();

	const sessionId = uuidv7();
	let supervisor: QcpSupervisorAgent;
	try {
		await ensurePackageGroups({
			commandName: "qcp chat",
			groups: getChatRuntimePackageGroups(activeConfig),
		});
		const { QcpSupervisorAgent } = await import(
			"../agents/supervisor-agent.js"
		);
		supervisor = await QcpSupervisorAgent.create({
			config: activeConfig,
			command: "chat",
			sessionId,
			connectionId: connection.id,
			connectionName: connection.name,
			databaseUrl: connection.databaseUrl,
			schema,
			approvalHandler: async (reasons, sql) =>
				confirmChatToolExecution(reasons, sql, activeConfig, options),
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		printError(message);
		trackError("chat", "provider_init_failed");
		await shutdownTelemetry();
		process.exit(1);
	}

	const session: ChatSession = {
		connectionName: connection.name,
		schema,
		supervisor,
		questionCount: 0,
		startTime: Date.now(),
	};

	// ── REPL ───────────────────────────────────────────────────────────────────
	const rl = readline.createInterface({ input, output, terminal: true });

	// Graceful Ctrl+C
	process.on("SIGINT", async () => {
		console.log();
		printInfo("Session ended. Goodbye!");
		rl.close();
		await shutdownTelemetry();
		process.exit(0);
	});

	while (true) {
		let line: string;
		try {
			line = await rl.question(chalk.cyan("\n  You › "));
		} catch {
			// readline closed (EOF / Ctrl+D)
			break;
		}

		const trimmed = line.trim();
		if (!trimmed) continue;

		// ── Built-in commands ──────────────────────────────────────────────────
		if (EXIT_COMMANDS.has(trimmed.toLowerCase())) {
			const elapsed = ((Date.now() - session.startTime) / 1000).toFixed(0);
			console.log();
			printInfo(
				`Session ended · ${session.questionCount} question${session.questionCount === 1 ? "" : "s"} · ${elapsed}s`,
			);
			break;
		}

		if (HELP_COMMANDS.has(trimmed.toLowerCase())) {
			_printHelp();
			continue;
		}

		if (CLEAR_COMMANDS.has(trimmed.toLowerCase())) {
			process.stdout.write("\x1Bc"); // clear screen
			continue;
		}

		if (SCHEMA_COMMANDS.has(trimmed.toLowerCase())) {
			_printSchemaOverview(session.schema);
			continue;
		}

		if (trimmed.startsWith("/")) {
			printInfo(
				`Unknown command: ${trimmed}. Type /help for available commands.`,
			);
			continue;
		}

		// ── Process question ───────────────────────────────────────────────────
		session.questionCount++;
		console.log();
		await _handleQuestion(trimmed, session, config);
	}

	rl.close();
	await shutdownTelemetry();
}

function getChatRuntimePackageGroups(
	config: ReturnType<typeof loadConfig>,
): PackageGroup[] {
	const groups: PackageGroup[] = [
		"agent",
		providerPackageGroup(config.provider),
	];
	if (config.databaseType === "prisma-postgres") groups.push("prisma");
	return groups;
}

// ─── Question handler ──────────────────────────────────────────────────────────

async function _handleQuestion(
	question: string,
	session: ChatSession,
	config: ReturnType<typeof loadConfig>,
): Promise<void> {
	const promptViolation = classifyPromptViolation(question);
	if (promptViolation) {
		printPromptViolation(promptViolation);
		trackQueryRejected(`${promptViolation.category}_prompt_violation`);
		return;
	}

	const spinner = ora("Thinking...").start();
	try {
		const response = await session.supervisor.generateResponse(question);
		spinner.succeed(response.direct ? "Ready" : "Done");
		printChatAnswer(response.text);

		trackQuery({
			provider: config.provider,
			model: config.model,
			latencyMs: response.latencyMs,
		});

		log("info", "Chat response completed", {
			direct: response.direct,
			question: question.slice(0, 60),
		});
	} catch (err: unknown) {
		spinner.fail("Assistant response failed");
		const msg = err instanceof Error ? err.message : String(err);
		printError(msg);
		trackError("chat", "assistant_response_failed");
	}
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function confirmChatToolExecution(
	reasons: ApprovalReason[],
	_sql: string,
	config: ReturnType<typeof loadConfig>,
	options: ChatOptions,
): Promise<boolean> {
	if (!config.safeMode || options.noConfirm) return true;

	printApprovalWarning(reasons);
	const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
		{
			type: "confirm",
			name: "confirmed",
			message: "Execute this query?",
			default: false,
		},
	]);
	trackHumanApproval(confirmed);
	return confirmed;
}

function printChatAnswer(answer: string): void {
	const sanitized = sanitizeSensitiveData(answer.trim());
	if (!sanitized) return;
	console.log(chalk.bold("\nAssistant:"));
	console.log(chalk.white(`  ${sanitized.replace(/\n/g, "\n  ")}`));
}

function _printHelp(): void {
	console.log();
	printSection("Chat Commands");
	const commands = [
		["/help, ?", "Show this help"],
		["/schema", "List all tables in the current database"],
		["qcp db use", "Switch the active database before starting chat"],
		["/clear", "Clear the screen"],
		["/exit, quit", "End the session"],
	];
	for (const [cmd, desc] of commands) {
		console.log(`  ${chalk.cyan(cmd.padEnd(18))} ${chalk.dim(desc)}`);
	}
	console.log();
	console.log(
		chalk.dim("  Anything else is treated as a question about your database."),
	);
	console.log();
	console.log(chalk.dim("  Example questions:"));
	console.log(chalk.dim("    What were our top 10 customers last month?"));
	console.log(chalk.dim("    Show me daily active users for the past week"));
	console.log(chalk.dim("    Which products have low inventory?"));
	console.log(chalk.dim("    Average order value by country"));
}

function _printSchemaOverview(schema: DatabaseSchema): void {
	console.log();
	printSection(`Tables in ${schema.databaseName}`);
	const maxShow = 30;
	for (const table of schema.tables.slice(0, maxShow)) {
		const id =
			table.schema === "public" ? table.name : `${table.schema}.${table.name}`;
		const cols = chalk.dim(`${table.columns.length} cols`);
		const rows = table.estimatedRows
			? chalk.dim(` ~${table.estimatedRows.toLocaleString()} rows`)
			: "";
		console.log(`  ${chalk.cyan(id.padEnd(30))} ${cols}${rows}`);
	}
	if (schema.tableCount > maxShow) {
		console.log(chalk.dim(`  ... and ${schema.tableCount - maxShow} more`));
	}
	console.log();
}
