import chalk from "chalk";
import inquirer from "inquirer";
import ora from "ora";
import { executeSecureQueryImprovementAnalysis } from "@/agents/database-tools.js";
import {
	getActiveDatabaseConnection,
	loadConfig,
	withActiveDatabaseConnection,
} from "@/config/index.js";
import { createProvider } from "@/llm/index.js";
import { isPromptViolationError } from "@/llm/prompts.js";
import { log } from "@/logger/index.js";
import {
	printApprovalWarning,
	printError,
	printExplanation,
	printInfo,
	printPromptViolation,
	printQuestion,
	printSafetyReport,
	printSection,
	printSql,
} from "@/output/index.js";
import {
	auditProviderRuntimePackages,
	ensurePackageGroups,
} from "@/packages/runtime.js";
import {
	isLikelySql,
	type QueryPerformanceAnalysis,
} from "@/performance/query-performance-analyzer.js";
import { classifyPromptViolation, validateSql } from "@/safety/index.js";
import { loadSchemaForConnection } from "@/schema/index.js";
import {
	initTelemetry,
	shutdownTelemetry,
	trackActive,
	trackHumanApproval,
} from "@/telemetry/index.js";
import type {
	ApprovalReason,
	DatabaseSchema,
	LLMProvider,
	SqlGenerationResult,
} from "@/types";

export interface ExplainOptions {
	showPlan?: boolean;
	safeMode?: boolean;
	noConfirm?: boolean;
}

export async function explainCommand(
	question: string,
	options: ExplainOptions = {},
): Promise<void> {
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

	// ── Load schema ─────────────────────────────────────────────────────────────
	const schemaSpinner = ora("Loading schema...").start();

	let schema: DatabaseSchema;
	try {
		schema = loadSchemaForConnection(connection).schema;
		schemaSpinner.succeed(
			`Schema loaded (${connection.name} · ${schema.tableCount} tables)`,
		);
	} catch (err: unknown) {
		schemaSpinner.fail("Schema not found");
		const message = err instanceof Error ? err.message : String(err);
		printError(message);
		await shutdownTelemetry();
		process.exit(1);
	}

	printQuestion(question);
	const rawSqlInput = isLikelySql(question);

	let sql: string;
	let generatedExplanation: string | undefined;

	if (rawSqlInput) {
		sql = question;
	} else {
		const promptViolation = classifyPromptViolation(question);
		if (promptViolation) {
			printPromptViolation(promptViolation);
			await shutdownTelemetry();
			process.exit(1);
		}

		// ── Create provider ───────────────────────────────────────────────────────
		let provider: LLMProvider;
		try {
			const packageAudit = auditProviderRuntimePackages(activeConfig.provider);
			if (packageAudit.missingGroups.length > 0) {
				await ensurePackageGroups({
					commandName: "qcp explain",
					groups: packageAudit.missingGroups,
				});
			}
			provider = await createProvider(activeConfig);
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			printError(message);
			await shutdownTelemetry();
			process.exit(1);
		}

		// ── Generate SQL ─────────────────────────────────────────────────────────
		const sqlSpinner = ora("Generating SQL...").start();

		let sqlResult: SqlGenerationResult;
		try {
			sqlResult = await provider.generateSql(question, schema);
			sqlSpinner.succeed("SQL generated");
		} catch (err: unknown) {
			sqlSpinner.fail("SQL generation failed");
			if (isPromptViolationError(err)) {
				printPromptViolation(err.violation);
				await shutdownTelemetry();
				process.exit(1);
			}
			const message = err instanceof Error ? err.message : String(err);
			printError(message);
			await shutdownTelemetry();
			process.exit(1);
		}

		sql = sqlResult.sql;
		generatedExplanation = sqlResult.explanation;
	}

	// ── Display SQL and explanation ──────────────────────────────────────────────
	printSql(sql);

	if (generatedExplanation) {
		printExplanation(generatedExplanation);
	}

	// ── Safety validation ────────────────────────────────────────────────────────
	const safetyReport = validateSql(sql);
	printSafetyReport(safetyReport);

	let analysis: QueryPerformanceAnalysis | undefined;
	let explainPlan: string | undefined;
	let estimatedRows = 0;

	// ── Query performance suggestions ───────────────────────────────────────────
	if (safetyReport.safe) {
		const planSpinner = ora("Analyzing query plan...").start();
		const suggestion = await executeSecureQueryImprovementAnalysis(
			{
				databaseUrl: connection.databaseUrl,
				schema,
				sensitiveTablePatterns: activeConfig.sensitiveTablePatterns,
				approvalHandler: async (reasons, approvedSql) =>
					confirmExplainInspection(reasons, approvedSql, activeConfig, options),
			},
			safetyReport.processedSql,
		);

		if (suggestion.ok) {
			planSpinner.succeed("Query plan analyzed");
			analysis = suggestion.analysis;
			explainPlan = suggestion.plan;
			estimatedRows = suggestion.estimatedRows;
			printQueryPerformanceAnalysis(analysis);
		} else {
			planSpinner.warn(suggestion.error);
		}
	}

	// ── EXPLAIN plan ─────────────────────────────────────────────────────────────
	if (options.showPlan && safetyReport.safe && explainPlan) {
		printSection("Query Plan");
		console.log(chalk.dim(explainPlan.slice(0, 3000)));

		if (estimatedRows > 0) {
			console.log(
				"\n" +
					chalk.dim("  Estimated rows scanned: ") +
					chalk.yellow(estimatedRows.toLocaleString()),
			);
		}
	}

	if (!options.showPlan && safetyReport.safe && explainPlan) {
		printInfo("Use --plan to see the PostgreSQL query execution plan");
	}

	if (!safetyReport.safe) {
		console.log();
		printInfo("This query would be rejected before execution.");
	} else {
		console.log();
		printInfo(
			"This command only analyzes the query; suggested DDL was not executed.",
		);
		if (!rawSqlInput) {
			printInfo(`Run \`qcp ask "${question}"\` to execute this query`);
		}
	}

	log("info", "Explain completed", { question });
	await shutdownTelemetry();
}

async function confirmExplainInspection(
	reasons: ApprovalReason[],
	_sql: string,
	config: ReturnType<typeof loadConfig>,
	options: ExplainOptions,
): Promise<boolean> {
	const safeMode = options.safeMode ?? config.safeMode;
	if (!safeMode || options.noConfirm) return true;

	printApprovalWarning(reasons);
	const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
		{
			type: "confirm",
			name: "confirmed",
			message: "Inspect this query plan?",
			default: false,
		},
	]);

	trackHumanApproval(confirmed);

	if (!confirmed) {
		console.log();
		printInfo("Query plan inspection cancelled.");
	}

	return confirmed;
}

function printQueryPerformanceAnalysis(
	analysis: QueryPerformanceAnalysis,
): void {
	printSection("Performance Suggestions");
	console.log(chalk.dim(`  ${analysis.summary}`));

	for (const finding of analysis.findings) {
		if (finding.type === "plan_summary") continue;
		const marker = finding.severity === "critical" ? "!" : "-";
		const color =
			finding.severity === "critical"
				? chalk.yellow.bold
				: finding.severity === "warning"
					? chalk.yellow
					: chalk.dim;
		console.log();
		console.log(color(`  ${marker} ${finding.title}`));
		console.log(chalk.dim(`    ${finding.detail}`));
		if (finding.suggestionSql) {
			console.log();
			console.log(chalk.green("    Suggested fix:"));
			console.log(chalk.white(`    ${finding.suggestionSql}`));
		}
	}

	if (
		analysis.suggestedIndexes.length === 0 &&
		analysis.warnings.length === 0
	) {
		console.log(
			chalk.dim("  No missing-index or wide SELECT * suggestions found."),
		);
	}
}
