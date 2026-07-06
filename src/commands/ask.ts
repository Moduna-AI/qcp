import inquirer from "inquirer";
import ora from "ora";
import type { QcpSupervisorAgent } from "@/agents/supervisor-agent.js";
import { AmazonMarketingCloudQueryService } from "@/amc/query-service.js";
import { scanAmazonMarketingCloudSchema } from "@/amc/schema.js";
import {
	ensureConfigDir,
	getActiveDatabaseConnection,
	loadConfig,
	saveConfig,
	withActiveDatabaseConnection,
} from "@/config/index.js";
import { createProvider } from "@/llm/index.js";
import { log } from "@/logger/index.js";
import {
	printApprovalWarning,
	printError,
	printExplanation,
	printInfo,
	printMetrics,
	printPromptViolation,
	printQuestion,
	printResults,
	printSection,
	printSql,
	printSuccess,
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
import {
	loadSchemaForConnection,
	saveSchemaForConnection,
	schemaToContext,
} from "@/schema/index.js";
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
	ActiveDatabaseConnection,
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
	exportPath?: string;
	dryRun?: boolean;
	since?: string;
	until?: string;
	timeZone?: string;
	limit?: number;
}

const AMAZON_MARKETING_CLOUD_SCHEMA_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
	let questionForAgent = question;
	let transferPackageGroup: PackageGroup | undefined;

	// ── Load schema once ──────────────────────────────────────────────────────────
	const schemaSpinner = ora("Loading schema...").start();
	let schema: DatabaseSchema;

	try {
		schema = loadSchemaForConnection(connection).schema;
		if (shouldRefreshAmazonMarketingCloudSchema(connection, schema)) {
			schemaSpinner.text = "Refreshing AMC data-source cache...";
			schema = await refreshAmazonMarketingCloudSchema(
				activeConfig,
				connection,
			);
		}
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

	if (connection.databaseType === "amazon-marketing-cloud") {
		await handleAmazonMarketingCloudAsk({
			question: questionForAgent,
			config,
			activeConfig,
			connection,
			schema,
			options,
		});
		await shutdownTelemetry();
		return;
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

async function handleAmazonMarketingCloudAsk(input: {
	readonly question: string;
	readonly config: ReturnType<typeof loadConfig>;
	readonly activeConfig: ReturnType<typeof loadConfig>;
	readonly connection: ActiveDatabaseConnection;
	readonly schema: DatabaseSchema;
	readonly options: AskOptions;
}): Promise<void> {
	printQuestion(input.question);

	const promptViolation = classifyPromptViolation(input.question);
	if (promptViolation) {
		printPromptViolation(promptViolation);
		trackQueryRejected(`${promptViolation.category}_prompt_violation`);
		process.exit(1);
	}

	const packageAudit = auditAskRuntimePackages(input.activeConfig);
	if (packageAudit.missingGroups.length > 0) {
		await ensurePackageGroups({
			commandName: "qcp ask",
			groups: packageAudit.missingGroups,
			verbose: input.options.verbose || input.options.debug,
		});
	}

	const provider = await createProvider(input.activeConfig);
	const service = new AmazonMarketingCloudQueryService({
		config: input.activeConfig,
		connection: input.connection,
		schema: input.schema,
		provider,
	});

	let interrupted = false;
	let lastWorkflowExecutionId: string | undefined;
	const spinner = ora(
		input.options.dryRun
			? "Generating and dry-running AMC SQL..."
			: "Generating AMC SQL...",
	).start();
	const onInterrupt = (): void => {
		interrupted = true;
	};
	process.once("SIGINT", onInterrupt);

	try {
		const result = await service.runQuestion(input.question, {
			dryRun: input.options.dryRun,
			exportPath: input.options.exportPath,
			since: input.options.since,
			until: input.options.until,
			timeZone: input.options.timeZone,
			limit: input.options.limit ?? 50,
			onPoll: (execution) => {
				lastWorkflowExecutionId = execution.workflowExecutionId;
				spinner.text = `AMC execution ${execution.workflowExecutionId}: ${execution.status}`;
			},
			shouldStopPolling: () => interrupted,
		});

		if (result.stoppedPolling) {
			spinner.warn(
				"Stopped local AMC polling; remote execution is still running.",
			);
			printAmazonMarketingCloudResultMetadata(result);
			const workflowExecutionId =
				result.execution?.workflowExecutionId ?? lastWorkflowExecutionId;
			if (workflowExecutionId) {
				printInfo(`Check status later: qcp amc status ${workflowExecutionId}`);
			}
			return;
		}

		if (
			result.execution &&
			result.execution.status !== "SUCCEEDED" &&
			!input.options.dryRun
		) {
			spinner.fail(`AMC execution ${result.execution.status}`);
			printAmazonMarketingCloudResultMetadata(result);
			if (result.execution.errorReason) {
				printError(result.execution.errorReason);
			}
			process.exit(1);
		}

		spinner.succeed(
			input.options.dryRun
				? "AMC dry-run completed"
				: "AMC execution completed",
		);
		printAmazonMarketingCloudResultMetadata(result);
		if (result.queryResult) {
			printResults(result.queryResult);
		}
		if (result.exportedFiles.length > 0) {
			printSuccess(`Exported ${result.exportedFiles.length} AMC file(s)`);
			for (const file of result.exportedFiles) {
				printInfo(file);
			}
		}

		trackQuery({
			provider: input.config.provider,
			model: input.config.model,
			latencyMs:
				result.sqlGeneration.latencyMs +
				(result.queryResult?.executionTimeMs ?? 0),
		});

		if (
			input.options.metrics ||
			input.options.verbose ||
			input.config.showMetrics
		) {
			const metrics: QueryMetrics = {
				tokensIn: result.sqlGeneration.tokensIn ?? 0,
				tokensOut: result.sqlGeneration.tokensOut ?? 0,
				totalLatencyMs:
					result.sqlGeneration.latencyMs +
					(result.queryResult?.executionTimeMs ?? 0),
				sqlGenerationMs: result.sqlGeneration.latencyMs,
				executionMs: result.queryResult?.executionTimeMs ?? 0,
				summaryMs: 0,
				provider: input.config.provider,
				model: input.config.model,
			};
			printMetrics(metrics);
		}
	} catch (err: unknown) {
		spinner.fail("AMC ask failed");
		const message = err instanceof Error ? err.message : String(err);
		printError(message);
		trackError("ask", "amc_ask_failed");
		process.exit(1);
	} finally {
		process.removeListener("SIGINT", onInterrupt);
	}
}

function printAmazonMarketingCloudResultMetadata(
	result: Awaited<ReturnType<AmazonMarketingCloudQueryService["runQuestion"]>>,
): void {
	printSql(result.sql);
	printExplanation(result.explanation);
	printSection("AMC Execution");
	console.log(`  Dry-run:     ${result.dryRunExecution.status}`);
	if (result.execution) {
		console.log(`  Execution:   ${result.execution.workflowExecutionId}`);
		console.log(`  Status:      ${result.execution.status}`);
	}
	console.log(
		`  Window:      ${result.timeWindow.start} to ${result.timeWindow.end}`,
	);
	console.log(`  Timezone:    ${result.timeWindow.timeZone}`);
}

function shouldRefreshAmazonMarketingCloudSchema(
	connection: ActiveDatabaseConnection,
	schema: DatabaseSchema,
): boolean {
	if (connection.databaseType !== "amazon-marketing-cloud") return false;
	const scannedAt = Date.parse(schema.scannedAt);
	if (Number.isNaN(scannedAt)) return true;
	return Date.now() - scannedAt > AMAZON_MARKETING_CLOUD_SCHEMA_MAX_AGE_MS;
}

async function refreshAmazonMarketingCloudSchema(
	config: ReturnType<typeof loadConfig>,
	connection: ActiveDatabaseConnection,
): Promise<DatabaseSchema> {
	const schema = await scanAmazonMarketingCloudSchema(connection, {
		onTokenRefresh: (accessToken, accessTokenExpiresAt) => {
			const databaseConnections = config.databaseConnections.map((candidate) =>
				candidate.id === connection.id && candidate.amazonMarketingCloud
					? {
							...candidate,
							amazonMarketingCloud: {
								...candidate.amazonMarketingCloud,
								accessToken,
								accessTokenExpiresAt,
							},
						}
					: candidate,
			);
			saveConfig({ ...config, databaseConnections });
		},
	});
	saveSchemaForConnection(connection, schema);
	return schema;
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
			type: "list",
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
