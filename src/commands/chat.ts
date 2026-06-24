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
import { getDatabaseUrl, loadConfig } from "../config/index.js";
import { executeQuery } from "../db/index.js";
import { createProvider } from "../llm/index.js";
import { log } from "../logger/index.js";
import {
	printApprovalWarning,
	printBanner,
	printError,
	printExplanation,
	printInfo,
	printResults,
	printSafetyReport,
	printSection,
	printSql,
	printSummary,
} from "../output/index.js";
import { getApprovalReasons, validateSql } from "../safety/index.js";
import { loadSchema } from "../schema/index.js";
import {
	initTelemetry,
	shutdownTelemetry,
	trackActive,
	trackError,
	trackHumanApproval,
	trackQuery,
	trackQueryRejected,
} from "../telemetry/index.js";
import type { DatabaseSchema, LLMProvider } from "../types/index.js";

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
	schema: DatabaseSchema;
	provider: LLMProvider;
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

	const databaseUrl = getDatabaseUrl(config);
	if (!databaseUrl) {
		printError("No database connection configured.", "Run: qcp connect <url>");
		await shutdownTelemetry();
		process.exit(1);
	}

	// ── Startup ────────────────────────────────────────────────────────────────
	printBanner();

	const schemaSpinner = ora("Loading schema...").start();
	let schema: DatabaseSchema;
	try {
		schema = loadSchema();
		schemaSpinner.succeed(
			`Schema loaded · ${schema.databaseName} · ${schema.tableCount} tables`,
		);
	} catch (err: unknown) {
		schemaSpinner.fail("Schema not found. Run: qcp schema scan");
		await shutdownTelemetry();
		process.exit(1);
	}

	let provider: LLMProvider;
	try {
		provider = createProvider(config);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		printError(msg);
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
			chalk.white(schema.databaseName) +
			chalk.dim(` · Provider: `) +
			chalk.white(`${config.provider}/${config.model}`),
	);
	console.log(
		chalk.dim("  Type your question, or ") +
			chalk.cyan("/help") +
			chalk.dim(" for commands. ") +
			chalk.cyan("/exit") +
			chalk.dim(" to quit."),
	);
	console.log();

	const session: ChatSession = {
		schema,
		provider,
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
		await _handleQuestion(trimmed, session, config, databaseUrl, options);
	}

	rl.close();
	await shutdownTelemetry();
}

// ─── Question handler ──────────────────────────────────────────────────────────

async function _handleQuestion(
	question: string,
	session: ChatSession,
	config: ReturnType<typeof loadConfig>,
	databaseUrl: string,
	options: ChatOptions,
): Promise<void> {
	// Generate SQL
	const sqlSpinner = ora("Generating SQL...").start();
	let sqlResult;

	try {
		sqlResult = await session.provider.generateSql(question, session.schema);
		sqlSpinner.succeed("SQL generated");
	} catch (err: unknown) {
		sqlSpinner.fail("SQL generation failed");
		const msg = err instanceof Error ? err.message : String(err);
		printError(msg);
		trackError("chat", "sql_generation_failed");
		return;
	}

	// Show SQL
	if (config.showSql) printSql(sqlResult.sql);

	// Safety validation
	const safetyReport = validateSql(sqlResult.sql);
	printSafetyReport(safetyReport);

	if (!safetyReport.safe) {
		printError("Query rejected — safety validation failed.");
		trackQueryRejected("safety_validation_failed");
		return;
	}

	// Human-in-the-loop approval
	if (config.safeMode && !options.noConfirm) {
		const reasons = getApprovalReasons(
			safetyReport.processedSql,
			safetyReport,
			config.sensitiveTablePatterns,
		);

		if (reasons.length > 0) {
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
			if (!confirmed) {
				printInfo("Skipped. Ask another question.");
				return;
			}
		}
	}

	// Execute
	const execSpinner = ora("Executing...").start();
	let queryResult;

	try {
		queryResult = await executeQuery(databaseUrl, safetyReport.processedSql);
		execSpinner.succeed(
			`${queryResult.rowCount} row(s) · ${queryResult.executionTimeMs}ms`,
		);
	} catch (err: unknown) {
		execSpinner.fail("Execution failed");
		const msg = err instanceof Error ? err.message : String(err);
		printError(msg);
		trackError("chat", "query_execution_failed");
		return;
	}

	printResults(queryResult);

	// Summary
	const summarySpinner = ora("Summarizing...").start();
	try {
		const summaryResult = await session.provider.generateSummary(
			question,
			safetyReport.processedSql,
			queryResult,
		);
		summarySpinner.succeed("Done");
		printSummary(summaryResult.summary);
	} catch {
		summarySpinner.stop();
	}

	if (sqlResult.explanation) printExplanation(sqlResult.explanation);

	trackQuery({
		provider: config.provider,
		model: config.model,
		latencyMs: sqlResult.latencyMs + queryResult.executionTimeMs,
	});

	log("info", "Chat query completed", {
		rows: queryResult.rowCount,
		question: question.slice(0, 60),
	});
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function _printHelp(): void {
	console.log();
	printSection("Chat Commands");
	const commands = [
		["/help, ?", "Show this help"],
		["/schema", "List all tables in the current database"],
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
