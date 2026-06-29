import chalk from "chalk";
import inquirer from "inquirer";
import ora from "ora";
import {
	executeSecurePrismaExplainQuery,
	executeSecurePrismaReadQuery,
	generateSqlWithPrismaAgent,
} from "@/agents/prisma-agent.js";
import { isPromptViolationError } from "@/llm/prompts.js";
import { log } from "@/logger/index.js";
import {
	printApprovalWarning,
	printError,
	printExplanation,
	printInfo,
	printMetrics,
	printPromptViolation,
	printResults,
	printSafetyReport,
	printSql,
	printSummary,
} from "@/output/index.js";
import {
	getApprovalReasons,
	sanitizeSensitiveData,
	validateSql,
} from "@/safety/index.js";
import {
	trackError,
	trackHumanApproval,
	trackQuery,
	trackQueryRejected,
} from "@/telemetry/index.js";
import type {
	DatabaseSchema,
	LLMProvider,
	QcpConfig,
	QueryMetrics,
	QueryResult,
	SecureQueryResult,
	SqlGenerationResult,
	SummaryResult,
} from "@/types/index.js";

export interface PrismaQuestionOptions {
	readonly metrics?: boolean;
	readonly verbose?: boolean;
	readonly debug?: boolean;
	readonly safeMode?: boolean;
	readonly noConfirm?: boolean;
}

export interface HandlePrismaQuestionOptions {
	readonly question: string;
	readonly schema: DatabaseSchema;
	readonly config: QcpConfig;
	readonly databaseUrl: string;
	readonly provider: LLMProvider;
	readonly commandName: "ask" | "chat";
	readonly options?: PrismaQuestionOptions;
}

export function shouldUsePrismaAgent(config: QcpConfig): boolean {
	return config.databaseType === "prisma-postgres";
}

export async function handlePrismaQuestion(
	input: HandlePrismaQuestionOptions,
): Promise<boolean> {
	const options = input.options ?? {};
	const sqlResult = await generateSql(input);
	if (!sqlResult) return false;

	if (options.debug) {
		console.log(chalk.dim("\n── Raw SQL from Prisma Agent ──"));
		console.log(chalk.dim(sqlResult.sql));
		console.log(chalk.dim("──────────────────────────────\n"));
	}

	if (input.config.showSql) {
		printSql(sqlResult.sql);
	}

	const safetyReport = validateSql(sqlResult.sql);
	printSafetyReport(safetyReport);

	if (!safetyReport.safe) {
		printError("Query rejected — does not meet safety requirements.");
		trackQueryRejected("safety_validation_failed");
		return false;
	}

	if (options.debug) {
		console.log(chalk.dim("── Processed SQL ──"));
		console.log(chalk.dim(safetyReport.processedSql));
		console.log();
	}

	let estimatedRows: number | undefined;
	const safeMode = options.safeMode ?? input.config.safeMode;

	if (safeMode || options.debug) {
		const explain = await executeSecurePrismaExplainQuery(
			{
				databaseUrl: input.databaseUrl,
				schema: input.schema,
				sensitiveTablePatterns: input.config.sensitiveTablePatterns,
			},
			safetyReport.processedSql,
		);
		if (explain.ok) {
			estimatedRows = explain.estimatedRows;
			if (options.debug) {
				console.log(chalk.dim("\n── EXPLAIN Plan ──"));
				console.log(chalk.dim(explain.plan.slice(0, 1200)));
				console.log();
			}
		} else if (options.debug) {
			console.log(chalk.dim(`EXPLAIN unavailable: ${explain.error}`));
		}
	}

	if (safeMode && !options.noConfirm) {
		const approvalReasons = getApprovalReasons(
			safetyReport.processedSql,
			safetyReport,
			input.config.sensitiveTablePatterns,
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
				printInfo(
					input.commandName === "chat"
						? "Skipped. Ask another question."
						: "Query cancelled.",
				);
				return input.commandName === "chat";
			}
		}
	}

	const queryResult = await executePrismaQuery(
		input,
		safetyReport.processedSql,
	);
	if (!queryResult) return false;

	printResults(queryResult.result);

	const summaryResult = await summarizePrismaResults(
		input,
		sqlResult,
		queryResult.result,
		queryResult.isolation.processedSql,
	);
	if (summaryResult) printSummary(summaryResult.summary);
	if (sqlResult.explanation) printExplanation(sqlResult.explanation);

	const totalMs =
		sqlResult.latencyMs +
		queryResult.result.executionTimeMs +
		(summaryResult?.latencyMs ?? 0);

	trackQuery({
		provider: input.config.provider,
		model: input.config.model,
		latencyMs: totalMs,
	});

	if (options.metrics || options.verbose || input.config.showMetrics) {
		const metrics: QueryMetrics = {
			tokensIn: (sqlResult.tokensIn ?? 0) + (summaryResult?.tokensIn ?? 0),
			tokensOut: (sqlResult.tokensOut ?? 0) + (summaryResult?.tokensOut ?? 0),
			totalLatencyMs: totalMs,
			sqlGenerationMs: sqlResult.latencyMs,
			executionMs: queryResult.result.executionTimeMs,
			summaryMs: summaryResult?.latencyMs ?? 0,
			provider: input.config.provider,
			model: input.config.model,
		};
		printMetrics(metrics);
	}

	log("info", "Prisma query completed", {
		provider: input.config.provider,
		model: input.config.model,
		rows: queryResult.result.rowCount,
		latencyMs: totalMs,
	});

	return true;
}

async function generateSql(
	input: HandlePrismaQuestionOptions,
): Promise<SqlGenerationResult | undefined> {
	const spinner = ora("Generating SQL with Prisma agent...").start();
	try {
		const result = await generateSqlWithPrismaAgent({
			question: input.question,
			schema: input.schema,
			config: input.config,
			databaseUrl: input.databaseUrl,
			debug: input.options?.debug,
		});
		spinner.succeed("SQL generated");
		return result;
	} catch (err: unknown) {
		spinner.fail("Prisma agent SQL generation failed");
		if (isPromptViolationError(err)) {
			printPromptViolation(err.violation);
			trackQueryRejected(`${err.violation.category}_prompt_violation`);
			return undefined;
		}
		const message = err instanceof Error ? err.message : String(err);
		printError(message);
		trackError(input.commandName, "prisma_sql_generation_failed");
		return undefined;
	}
}

async function executePrismaQuery(
	input: HandlePrismaQuestionOptions,
	sql: string,
): Promise<SecureQueryResult | undefined> {
	const spinner = ora(
		input.commandName === "chat" ? "Executing..." : "Executing query...",
	).start();
	const queryResult = await executeSecurePrismaReadQuery(
		{
			databaseUrl: input.databaseUrl,
			schema: input.schema,
			sensitiveTablePatterns: input.config.sensitiveTablePatterns,
		},
		sql,
	);

	if (!queryResult.ok) {
		spinner.fail(
			input.commandName === "chat"
				? "Execution failed"
				: "Query execution failed",
		);
		printError(queryResult.error);
		trackError(input.commandName, "prisma_query_execution_failed");
		return undefined;
	}

	spinner.succeed(
		input.commandName === "chat"
			? `${queryResult.result.rowCount} row(s) · ${queryResult.result.executionTimeMs}ms`
			: `Query executed · ${queryResult.result.rowCount} row(s) · ${queryResult.result.executionTimeMs}ms`,
	);
	return queryResult;
}

async function summarizePrismaResults(
	input: HandlePrismaQuestionOptions,
	sqlResult: SqlGenerationResult,
	queryResult: QueryResult,
	executedSql: string,
): Promise<SummaryResult | undefined> {
	const spinner = ora(
		input.commandName === "chat" ? "Summarizing..." : "Generating summary...",
	).start();
	try {
		const summaryResult = await input.provider.generateSummary(
			input.question,
			sanitizeSensitiveData(executedSql),
			queryResult,
			(chunk) => {
				if (input.options?.debug) {
					process.stderr.write(chalk.dim(sanitizeSensitiveData(chunk)));
				}
			},
		);
		spinner.succeed(input.commandName === "chat" ? "Done" : "Summary ready");
		return summaryResult;
	} catch {
		if (input.commandName === "chat") {
			spinner.stop();
		} else {
			spinner.warn("Summary unavailable");
		}
		return undefined;
	}
}
