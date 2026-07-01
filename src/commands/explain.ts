import chalk from "chalk";
import ora from "ora";
import {
	getActiveDatabaseConnection,
	loadConfig,
	withActiveDatabaseConnection,
} from "@/config/index.js";
import { explainQuery } from "@/db/index.js";
import { createProvider } from "@/llm/index.js";
import { isPromptViolationError } from "@/llm/prompts.js";
import { log } from "@/logger/index.js";
import {
	printError,
	printExplanation,
	printInfo,
	printPromptViolation,
	printQuestion,
	printSafetyReport,
	printSection,
	printSql,
} from "@/output/index.js";
import { classifyPromptViolation, validateSql } from "@/safety/index.js";
import { loadSchemaForConnection } from "@/schema/index.js";
import {
	initTelemetry,
	shutdownTelemetry,
	trackActive,
} from "@/telemetry/index.js";
import type { DatabaseSchema, LLMProvider, SqlGenerationResult } from "@/types";

export interface ExplainOptions {
	showPlan?: boolean;
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

	// ── Create provider ─────────────────────────────────────────────────────────
	let provider: LLMProvider;
	try {
		provider = createProvider(activeConfig);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		printError(message);
		await shutdownTelemetry();
		process.exit(1);
	}

	printQuestion(question);

	const promptViolation = classifyPromptViolation(question);
	if (promptViolation) {
		printPromptViolation(promptViolation);
		await shutdownTelemetry();
		process.exit(1);
	}

	// ── Generate SQL ─────────────────────────────────────────────────────────────
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

	// ── Display SQL and explanation ──────────────────────────────────────────────
	printSql(sqlResult.sql);

	if (sqlResult.explanation) {
		printExplanation(sqlResult.explanation);
	}

	// ── Safety validation ────────────────────────────────────────────────────────
	const safetyReport = validateSql(sqlResult.sql);
	printSafetyReport(safetyReport);

	// ── EXPLAIN plan ─────────────────────────────────────────────────────────────
	if (options.showPlan && safetyReport.safe) {
		const planSpinner = ora("Fetching query plan...").start();
		try {
			const explain = await explainQuery(
				connection.databaseUrl,
				safetyReport.processedSql,
			);
			planSpinner.succeed("Query plan retrieved");

			printSection("Query Plan");
			console.log(chalk.dim(explain.plan.slice(0, 3000)));

			if (explain.estimatedRows > 0) {
				console.log(
					"\n" +
						chalk.dim("  Estimated rows scanned: ") +
						chalk.yellow(explain.estimatedRows.toLocaleString()),
				);
			}
		} catch {
			planSpinner.warn("Could not fetch query plan");
		}
	}

	if (!options.showPlan && safetyReport.safe) {
		printInfo("Use --plan to see the PostgreSQL query execution plan");
	}

	if (!safetyReport.safe) {
		console.log();
		printInfo("This query would be rejected before execution.");
	} else {
		console.log();
		printInfo(`Run \`qcp ask "${question}"\` to execute this query`);
	}

	log("info", "Explain completed", { question });
	await shutdownTelemetry();
}
