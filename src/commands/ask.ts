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
import { semanticStoreExists } from "@/semantic/store.js";
import {
	initTelemetry,
	shutdownTelemetry,
	trackActive,
	trackError,
	trackHumanApproval,
	trackQuery,
	trackQueryRejected,
} from "@/telemetry/index.js";
import {
	resolveTransferIntent,
	supportedTransferFormatChoices,
} from "@/transfer/intent.js";
import type {
	DatabaseTransferDirection,
	DatabaseTransferFormat,
} from "@/transfer/types.js";
import type {
	ApprovalReason,
	DatabaseSchema,
	QueryMetrics,
	SafetyLevel,
} from "@/types/index.js";

export interface AskOptions {
	metrics?: boolean;
	verbose?: boolean;
	debug?: boolean;
	safeMode?: boolean;
	safetyLevel?: SafetyLevel;
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
	const activeConfig = {
		...withActiveDatabaseConnection(config, connection),
		safetyLevel: resolveSafetyLevelOption(options, config.safetyLevel),
	};
	let questionForAgent = question;
	let transferPackageGroup: PackageGroup | undefined;

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
		const transferIntent = await resolveTransferIntentForAsk(
			questionForAgent,
			options,
		);
		if (transferIntent.question) {
			questionForAgent = transferIntent.question;
		}
		transferPackageGroup = transferIntent.packageGroup;
		const packageAudit = auditAskRuntimePackages(
			activeConfig,
			undefined,
			semanticStoreExists(),
			transferPackageGroup,
		);
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
			semanticInteractive: shouldPromptForSemanticEnrichment(options),
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

	printQuestion(questionForAgent);

	const promptViolation = classifyPromptViolation(questionForAgent);
	if (promptViolation) {
		printPromptViolation(promptViolation);
		trackQueryRejected(`${promptViolation.category}_prompt_violation`);
		await shutdownTelemetry();
		process.exit(1);
	}

	// ── Ask supervisor ────────────────────────────────────────────────────────────
	const responseSpinner = ora("Thinking...").start();
	try {
		const response = await supervisor.generateResponse(questionForAgent);
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
	semanticEnabled = false,
	transferPackageGroup?: PackageGroup,
): PackageGroup[] {
	const groups: PackageGroup[] = [
		"agent",
		providerPackageGroup(config.provider),
	];
	if (config.databaseType === "prisma-postgres") groups.push("prisma");
	if (config.databaseType === "neon") groups.push("neon");
	if (semanticEnabled) groups.push("semantic");
	if (transferPackageGroup) groups.push(transferPackageGroup);
	return groups;
}

export function auditAskRuntimePackages(
	config: ReturnType<typeof loadConfig>,
	targetDir?: string,
	semanticEnabled = false,
	transferPackageGroup?: PackageGroup,
): PackageGroupsAudit {
	return auditPackageGroups(
		getAskRuntimePackageGroups(config, semanticEnabled, transferPackageGroup),
		targetDir,
	);
}

async function resolveTransferIntentForAsk(
	question: string,
	options: AskOptions,
): Promise<{
	readonly question?: string;
	readonly packageGroup?: PackageGroup;
}> {
	return resolveTransferIntent({
		question,
		noConfirm: options.noConfirm === true,
		isInteractive: process.stdin.isTTY === true,
		promptForFormat: promptForTransferFormat,
		promptForImportFilePath,
		promptForExportFilePath,
		promptForExportResource,
	});
}

async function promptForImportFilePath(): Promise<string | undefined> {
	const { filePath } = await inquirer.prompt<{ filePath: string }>([
		{
			type: "input",
			name: "filePath",
			message: "Enter import file path",
			validate: (value: string) =>
				value.trim().length > 0 ? true : "Import file path is required.",
		},
	]);
	return filePath.trim();
}

async function promptForExportFilePath(
	format: DatabaseTransferFormat,
): Promise<string | undefined> {
	const { filePath } = await inquirer.prompt<{ filePath: string }>([
		{
			type: "input",
			name: "filePath",
			message: "Enter export output file path",
			default: `qcp-export.${defaultExtensionForFormat(format)}`,
			validate: (value: string) =>
				value.trim().length > 0 ? true : "Export output file path is required.",
		},
	]);
	return filePath.trim();
}

async function promptForExportResource(): Promise<string | undefined> {
	const { resource } = await inquirer.prompt<{ resource: string }>([
		{
			type: "input",
			name: "resource",
			message: "Enter table, schema, database, or query to export",
			validate: (value: string) =>
				value.trim().length > 0 ? true : "Export resource is required.",
		},
	]);
	return resource.trim();
}

async function promptForTransferFormat(
	direction: DatabaseTransferDirection,
): Promise<
	ReturnType<typeof supportedTransferFormatChoices>[number] | undefined
> {
	const choices = supportedTransferFormatChoices(direction);
	const { format } = await inquirer.prompt<{
		format: ReturnType<typeof supportedTransferFormatChoices>[number];
	}>([
		{
			type: "select",
			name: "format",
			message: `Select ${direction} file format`,
			choices: choices.map((choice) => ({ name: choice, value: choice })),
		},
	]);
	return format;
}

function defaultExtensionForFormat(format: DatabaseTransferFormat): string {
	switch (format) {
		case "csv":
			return "csv";
		case "tsv":
			return "tsv";
		case "json":
			return "json";
		case "jsonl":
			return "jsonl";
		case "parquet":
			return "parquet";
		case "sqlite":
			return "db";
		case "pandas":
			return "pd";
		case "postgres-dump":
			return "sql";
		default: {
			const _exhaustive: never = format;
			return _exhaustive;
		}
	}
}

function shouldPromptForSemanticEnrichment(options: AskOptions): boolean {
	return options.noConfirm !== true && process.stdin.isTTY === true;
}

async function confirmAskToolExecution(
	reasons: ApprovalReason[],
	operation: string,
	config: ReturnType<typeof loadConfig>,
	options: AskOptions,
): Promise<boolean> {
	const safetyLevel = resolveSafetyLevelOption(options, config.safetyLevel);
	if (options.noConfirm && safetyLevel !== "strict") return true;

	printApprovalWarning(reasons);
	printInfo(`Operation: ${operation}`);
	const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
		{
			type: "confirm",
			name: "confirmed",
			message: "Approve this operation?",
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

function resolveSafetyLevelOption(
	options: Pick<AskOptions, "safeMode" | "safetyLevel">,
	configSafetyLevel: SafetyLevel,
): SafetyLevel {
	return (
		options.safetyLevel ??
		(options.safeMode === false ? "low" : configSafetyLevel)
	);
}
