import inquirer from "inquirer";
import ora from "ora";
import type { QcpSupervisorAgent } from "@/agents/supervisor-agent.js";
import {
	ensureConfigDir,
	getActiveDatabaseConnection,
	loadConfig,
	withActiveDatabaseConnection,
} from "@/config/index.js";
import { log } from "@/logger/index.js";
import {
	printApprovalWarning,
	printError,
	printInfo,
	printMetrics,
	printPromptViolation,
	printQuestion,
	printSummary,
} from "@/output/index.js";
import {
	type PackageGroup,
	providerPackageGroup,
} from "@/packages/lazy-packages.js";
import {
	auditPackageGroups,
	ensurePackageGroups,
	type PackageGroupsAudit,
} from "@/packages/runtime.js";
import { classifyPromptViolation } from "@/safety/index.js";
import { loadSchemaForConnection, schemaToContext } from "@/schema/index.js";
import {
	initTelemetry,
	shutdownTelemetry,
	trackActive,
	trackError,
	trackHumanApproval,
	trackQuery,
	trackQueryRejected,
} from "@/telemetry/index.js";
import type {
	ApprovalReason,
	DatabaseSchema,
	QueryMetrics,
} from "@/types/index.js";

export interface AskOptions {
	metrics?: boolean;
	verbose?: boolean;
	debug?: boolean;
	safeMode?: boolean;
	noConfirm?: boolean;
}

export async function askCommand(
	question: string,
	options: AskOptions = {},
): Promise<void> {
	ensureConfigDir();
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

	// ── Load schema once ──────────────────────────────────────────────────────────
	const schemaSpinner = ora("Loading schema...").start();
	let schema: DatabaseSchema;

	try {
		schema = loadSchemaForConnection(connection).schema;
		schemaSpinner.succeed(
			`Schema loaded (${connection.name} · ${schema.tableCount} tables)`,
		);
		if (options.verbose || options.debug) {
			printInfo(`Schema context: ~${schemaToContext(schema).length} chars`);
		}
	} catch (err: unknown) {
		schemaSpinner.fail("Schema not found");
		const message = err instanceof Error ? err.message : String(err);
		printError(message);
		await shutdownTelemetry();
		process.exit(1);
	}

	// ── Create supervisor agent ───────────────────────────────────────────────────
	let supervisor: QcpSupervisorAgent;
	try {
		const packageAudit = auditAskRuntimePackages(activeConfig);
		if (packageAudit.missingGroups.length > 0) {
			await ensurePackageGroups({
				commandName: "qcp ask",
				groups: packageAudit.missingGroups,
				verbose: options.verbose || options.debug,
			});
		}
		const { QcpSupervisorAgent } = await import(
			"../agents/supervisor-agent.js"
		);
		supervisor = await QcpSupervisorAgent.create({
			config: activeConfig,
			command: "ask",
			connectionId: connection.id,
			connectionName: connection.name,
			databaseUrl: connection.databaseUrl,
			schema,
			approvalHandler: async (reasons, sql) =>
				confirmAskToolExecution(reasons, sql, activeConfig, options),
		});
		if (options.verbose || options.debug) {
			printInfo(`Database: ${connection.name}`);
			printInfo(`Provider: ${activeConfig.provider} / ${activeConfig.model}`);
			printInfo(
				`Database subagent: ${supervisor.getDatabaseAgent().getName()}`,
			);
		}
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		printError(message);
		trackError("ask", "provider_init_failed");
		await shutdownTelemetry();
		process.exit(1);
	}

	printQuestion(question);

	const promptViolation = classifyPromptViolation(question);
	if (promptViolation) {
		printPromptViolation(promptViolation);
		trackQueryRejected(`${promptViolation.category}_prompt_violation`);
		await shutdownTelemetry();
		process.exit(1);
	}

	// ── Ask supervisor ────────────────────────────────────────────────────────────
	const responseSpinner = ora("Thinking...").start();
	try {
		const response = await supervisor.generateResponse(question);
		responseSpinner.succeed(response.direct ? "Ready" : "Done");
		printSummary(response.text);

		trackQuery({
			provider: config.provider,
			model: config.model,
			latencyMs: response.latencyMs,
		});

		if (options.metrics || options.verbose || config.showMetrics) {
			const metrics: QueryMetrics = {
				tokensIn: response.tokensIn ?? 0,
				tokensOut: response.tokensOut ?? 0,
				totalLatencyMs: response.latencyMs,
				sqlGenerationMs: 0,
				executionMs: 0,
				summaryMs: response.latencyMs,
				provider: config.provider,
				model: config.model,
			};
			printMetrics(metrics);
		}

		log("info", "Ask response completed", {
			provider: config.provider,
			model: config.model,
			direct: response.direct,
			latencyMs: response.latencyMs,
		});
	} catch (err: unknown) {
		responseSpinner.fail("Assistant response failed");
		const message = err instanceof Error ? err.message : String(err);
		printError(message);
		trackError("ask", "assistant_response_failed");
		await shutdownTelemetry();
		process.exit(1);
	}

	await shutdownTelemetry();
}

function getAskRuntimePackageGroups(
	config: ReturnType<typeof loadConfig>,
): PackageGroup[] {
	const groups: PackageGroup[] = [
		"agent",
		providerPackageGroup(config.provider),
	];
	if (config.databaseType === "prisma-postgres") groups.push("prisma");
	if (config.databaseType === "neon") groups.push("neon");
	return groups;
}

export function auditAskRuntimePackages(
	config: ReturnType<typeof loadConfig>,
	targetDir?: string,
): PackageGroupsAudit {
	return auditPackageGroups(getAskRuntimePackageGroups(config), targetDir);
}

async function confirmAskToolExecution(
	reasons: ApprovalReason[],
	_sql: string,
	config: ReturnType<typeof loadConfig>,
	options: AskOptions,
): Promise<boolean> {
	const safeMode = options.safeMode ?? config.safeMode;
	if (!safeMode || options.noConfirm) return true;

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
		console.log();
		printInfo("Query cancelled.");
	}

	return confirmed;
}
