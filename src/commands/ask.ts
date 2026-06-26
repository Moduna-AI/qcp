import chalk from "chalk";
import inquirer from "inquirer";
import ora from "ora";
import { ensureConfigDir, getDatabaseUrl, loadConfig } from "@/config/index.js";
import { executeQuery, explainQuery } from "@/db/index.js";
import { createProvider } from "@/llm/index.js";
import { log } from "@/logger/index.js";
import {
	printApprovalWarning,
	printError,
	printExplanation,
	printInfo,
	printMetrics,
	printQuestion,
	printResults,
	printSafetyReport,
	printSql,
	printSummary,
} from "@/output/index.js";
import { getApprovalReasons, validateSql } from "@/safety/index.js";
import { loadSchema, schemaToContext } from "@/schema/index.js";
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
	DatabaseSchema,
	LLMProvider,
	QueryMetrics,
	QueryResult,
	SqlGenerationResult,
	SummaryResult,
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

	const databaseUrl = getDatabaseUrl(config);
	if (!databaseUrl) {
		printError(
			"No database connection configured.",
			"Run: qcp connect postgres://user:pass@host/db",
		);
		await shutdownTelemetry();
		process.exit(1);
	}

	// ── Load schema once ──────────────────────────────────────────────────────────
	const schemaSpinner = ora("Loading schema...").start();
	let schema: DatabaseSchema;

	try {
		schema = loadSchema();
		schemaSpinner.succeed(`Schema loaded (${schema.tableCount} tables)`);
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

	// ── Create LLM provider ───────────────────────────────────────────────────────
	let provider: LLMProvider;
	try {
		provider = createProvider(config);
		if (options.verbose || options.debug) {
			printInfo(`Provider: ${config.provider} / ${config.model}`);
		}
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		printError(message);
		trackError("ask", "provider_init_failed");
		await shutdownTelemetry();
		process.exit(1);
	}

	printQuestion(question);

	// ── Generate SQL ──────────────────────────────────────────────────────────────
	const sqlSpinner = ora("Generating SQL...").start();
	let sqlResult: SqlGenerationResult;

	try {
		sqlResult = await provider.generateSql(question, schema, (chunk) => {
			if (options.debug) process.stderr.write(chalk.dim(chunk));
		});
		sqlSpinner.succeed("SQL generated");
	} catch (err: unknown) {
		sqlSpinner.fail("SQL generation failed");
		const message = err instanceof Error ? err.message : String(err);
		printError(message);
		trackError("ask", "sql_generation_failed");
		await shutdownTelemetry();
		process.exit(1);
	}

	if (options.debug) {
		console.log(chalk.dim("\n── Raw SQL from LLM ──"));
		console.log(chalk.dim(sqlResult.sql));
		console.log(chalk.dim("─────────────────────\n"));
	}

	// ── Display SQL ───────────────────────────────────────────────────────────────
	if (config.showSql) {
		printSql(sqlResult.sql);
	}

	// ── Safety validation (AST) ───────────────────────────────────────────────────
	const safetyReport = validateSql(sqlResult.sql);
	printSafetyReport(safetyReport);

	if (!safetyReport.safe) {
		console.log();
		printError("Query rejected — does not meet safety requirements.");
		trackQueryRejected("safety_validation_failed");
		await shutdownTelemetry();
		process.exit(1);
	}

	if (options.debug) {
		console.log(chalk.dim("── Processed SQL ──"));
		console.log(chalk.dim(safetyReport.processedSql));
		console.log();
	}

	// ── EXPLAIN plan (for cost check in safe mode) ────────────────────────────────
	let estimatedRows: number | undefined;
	const safeMode = options.safeMode ?? config.safeMode;

	if (safeMode || options.debug) {
		try {
			const explain = await explainQuery(
				databaseUrl,
				safetyReport.processedSql,
			);
			estimatedRows = explain.estimatedRows;
			if (options.debug) {
				console.log(chalk.dim("\n── EXPLAIN Plan ──"));
				console.log(chalk.dim(explain.plan.slice(0, 1200)));
				console.log();
			}
		} catch {
			// Non-fatal — EXPLAIN failure doesn't block execution
		}
	}

	// ── Human-in-the-loop approval ────────────────────────────────────────────────
	if (safeMode && !options.noConfirm) {
		const approvalReasons = getApprovalReasons(
			safetyReport.processedSql,
			safetyReport,
			config.sensitiveTablePatterns,
			estimatedRows,
		);

		if (approvalReasons.length > 0) {
			printApprovalWarning(approvalReasons);
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
				await shutdownTelemetry();
				process.exit(0);
			}
		}
	}

	// ── Execute query ─────────────────────────────────────────────────────────────
	const execSpinner = ora("Executing query...").start();
	let queryResult: QueryResult;

	try {
		queryResult = await executeQuery(databaseUrl, safetyReport.processedSql);
		execSpinner.succeed(
			`Query executed · ${queryResult.rowCount} row(s) · ${queryResult.executionTimeMs}ms`,
		);
	} catch (err: unknown) {
		execSpinner.fail("Query execution failed");
		const message = err instanceof Error ? err.message : String(err);
		printError(message);
		trackError("ask", "query_execution_failed");
		await shutdownTelemetry();
		process.exit(1);
	}

	printResults(queryResult);

	// ── Generate summary ──────────────────────────────────────────────────────────
	let summaryResult: SummaryResult | undefined;
	const summarySpinner = ora("Generating summary...").start();

	try {
		summaryResult = await provider.generateSummary(
			question,
			safetyReport.processedSql,
			queryResult,
			(chunk) => {
				if (options.debug) process.stderr.write(chalk.dim(chunk));
			},
		);
		summarySpinner.succeed("Summary ready");
	} catch {
		summarySpinner.warn("Summary unavailable");
	}

	if (summaryResult) printSummary(summaryResult.summary);
	if (sqlResult.explanation) printExplanation(sqlResult.explanation);

	// ── Telemetry ─────────────────────────────────────────────────────────────────
	const totalMs =
		sqlResult.latencyMs +
		queryResult.executionTimeMs +
		(summaryResult?.latencyMs ?? 0);

	trackQuery({
		provider: config.provider,
		model: config.model,
		latencyMs: totalMs,
	});

	// ── Metrics ───────────────────────────────────────────────────────────────────
	if (options.metrics || options.verbose || config.showMetrics) {
		const metrics: QueryMetrics = {
			tokensIn: (sqlResult.tokensIn ?? 0) + (summaryResult?.tokensIn ?? 0),
			tokensOut: (sqlResult.tokensOut ?? 0) + (summaryResult?.tokensOut ?? 0),
			totalLatencyMs: totalMs,
			sqlGenerationMs: sqlResult.latencyMs,
			executionMs: queryResult.executionTimeMs,
			summaryMs: summaryResult?.latencyMs ?? 0,
			provider: config.provider,
			model: config.model,
		};
		printMetrics(metrics);
	}

	log("info", "Query completed", {
		provider: config.provider,
		model: config.model,
		rows: queryResult.rowCount,
		latencyMs: totalMs,
	});

	await shutdownTelemetry();
}
