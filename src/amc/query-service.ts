import { randomUUID } from "node:crypto";
import { saveConfig } from "@/config/index.js";
import type {
	ActiveDatabaseConnection,
	DatabaseSchema,
	LLMProvider,
	QcpConfig,
} from "@/types/index.js";
import { AmazonMarketingCloudClient } from "./client.js";
import { resolveAmazonMarketingCloudConnectionConfig } from "./config.js";
import {
	type AmcDownloadedFile,
	exportAmazonMarketingCloudFiles,
	parseAmazonMarketingCloudResults,
} from "./results.js";
import { assertValidAmazonMarketingCloudSql } from "./sql-safety.js";
import { resolveAmazonMarketingCloudTimeWindow } from "./time-window.js";
import type {
	AmcRunQuestionOptions,
	AmcRunQuestionResult,
	AmcWorkflowExecution,
} from "./types.js";

const DEFAULT_POLL_INTERVAL_MS = 10_000;

export interface AmazonMarketingCloudQueryServiceOptions {
	readonly config: QcpConfig;
	readonly connection: ActiveDatabaseConnection;
	readonly schema: DatabaseSchema;
	readonly provider: LLMProvider;
	readonly client?: AmazonMarketingCloudClient;
	readonly now?: () => Date;
	readonly sleep?: (ms: number) => Promise<void>;
}

export class AmazonMarketingCloudQueryService {
	private readonly config: QcpConfig;
	private readonly connection: ActiveDatabaseConnection;
	private readonly schema: DatabaseSchema;
	private readonly provider: LLMProvider;
	private readonly client: AmazonMarketingCloudClient;
	private readonly now: () => Date;
	private readonly sleep: (ms: number) => Promise<void>;

	public constructor(options: AmazonMarketingCloudQueryServiceOptions) {
		this.config = options.config;
		this.connection = options.connection;
		this.schema = options.schema;
		this.provider = options.provider;
		this.now = options.now ?? (() => new Date());
		this.sleep =
			options.sleep ??
			((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.client =
			options.client ??
			new AmazonMarketingCloudClient({
				config: resolveAmazonMarketingCloudConnectionConfig(options.connection),
				onTokenRefresh: async (accessToken, accessTokenExpiresAt) => {
					await this.persistRefreshedToken(accessToken, accessTokenExpiresAt);
				},
			});
	}

	public async runQuestion(
		question: string,
		options: AmcRunQuestionOptions = {},
	): Promise<AmcRunQuestionResult> {
		const startedAt = Date.now();
		const limit = options.limit ?? 50;
		const timeWindow = resolveAmazonMarketingCloudTimeWindow({
			question,
			since: options.since,
			until: options.until,
			timeZone: options.timeZone,
			now: this.now(),
		});
		const sqlGeneration = await this.provider.generateSql(
			buildAmazonMarketingCloudSqlQuestion(question, timeWindow),
			this.schema,
		);
		const sql = assertValidAmazonMarketingCloudSql(sqlGeneration.sql);
		const workflowId = `qcp-${randomUUID()}`;

		const dryRunExecution = await this.client.createWorkflowExecution({
			sql,
			workflowId,
			dryRun: true,
			timeWindowStart: timeWindow.start,
			timeWindowEnd: timeWindow.end,
			timeWindowTimeZone: timeWindow.timeZone,
		});

		if (options.dryRun) {
			return {
				question,
				sql,
				explanation: sqlGeneration.explanation,
				sqlGeneration,
				dryRunExecution,
				timeWindow,
				exportedFiles: [],
				stoppedPolling: false,
			};
		}

		const execution = await this.client.createWorkflowExecution({
			sql,
			workflowId,
			dryRun: false,
			timeWindowStart: timeWindow.start,
			timeWindowEnd: timeWindow.end,
			timeWindowTimeZone: timeWindow.timeZone,
		});
		const finalExecution = await this.pollUntilTerminal(
			execution,
			options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
			options.onPoll,
			options.shouldStopPolling,
		);

		if (!isTerminalSuccess(finalExecution)) {
			return {
				question,
				sql,
				explanation: sqlGeneration.explanation,
				sqlGeneration,
				dryRunExecution,
				execution: finalExecution,
				timeWindow,
				exportedFiles: [],
				stoppedPolling:
					finalExecution.status === "RUNNING" ||
					finalExecution.status === "PENDING",
			};
		}

		const files = await this.downloadExecutionFiles(
			finalExecution.workflowExecutionId,
		);
		const queryResult = parseAmazonMarketingCloudResults(
			files,
			Date.now() - startedAt,
			limit,
		);
		const exportedFiles = await exportAmazonMarketingCloudFiles(
			files,
			options.exportPath,
		);

		return {
			question,
			sql,
			explanation: sqlGeneration.explanation,
			sqlGeneration,
			dryRunExecution,
			execution: finalExecution,
			timeWindow,
			queryResult,
			exportedFiles,
			stoppedPolling: false,
		};
	}

	public async getExecutionStatus(
		workflowExecutionId: string,
	): Promise<AmcWorkflowExecution> {
		return await this.client.getWorkflowExecution(workflowExecutionId);
	}

	private async pollUntilTerminal(
		initialExecution: AmcWorkflowExecution,
		pollIntervalMs: number,
		onPoll: ((execution: AmcWorkflowExecution) => void) | undefined,
		shouldStopPolling: (() => boolean) | undefined,
	): Promise<AmcWorkflowExecution> {
		let execution = initialExecution;
		onPoll?.(execution);

		while (execution.status === "PENDING" || execution.status === "RUNNING") {
			if (shouldStopPolling?.()) return execution;
			await this.sleep(pollIntervalMs);
			if (shouldStopPolling?.()) return execution;
			execution = await this.client.getWorkflowExecution(
				execution.workflowExecutionId,
			);
			onPoll?.(execution);
		}

		return execution;
	}

	private async downloadExecutionFiles(
		workflowExecutionId: string,
	): Promise<AmcDownloadedFile[]> {
		const files: AmcDownloadedFile[] = [];
		let nextToken: string | undefined;

		do {
			const page = await this.client.getWorkflowExecutionDownloadUrls(
				workflowExecutionId,
				nextToken,
			);
			for (const url of page.downloadUrls) {
				files.push({
					url,
					body: await this.client.downloadText(url),
					kind: "result",
				});
			}
			for (const url of page.metadataDownloadUrls) {
				files.push({
					url,
					body: await this.client.downloadText(url),
					kind: "metadata",
				});
			}
			nextToken = page.nextToken;
		} while (nextToken);

		return files;
	}

	private async persistRefreshedToken(
		accessToken: string,
		accessTokenExpiresAt: string,
	): Promise<void> {
		const connections = this.config.databaseConnections.map((connection) =>
			connection.id === this.connection.id && connection.amazonMarketingCloud
				? {
						...connection,
						amazonMarketingCloud: {
							...connection.amazonMarketingCloud,
							accessToken,
							accessTokenExpiresAt,
						},
					}
				: connection,
		);
		saveConfig({ ...this.config, databaseConnections: connections });
	}
}

export function buildAmazonMarketingCloudSqlQuestion(
	question: string,
	timeWindow: {
		readonly start: string;
		readonly end: string;
		readonly timeZone: string;
	},
): string {
	return [
		question,
		"",
		"Generate Amazon Marketing Cloud Presto SQL.",
		"Use only SELECT or WITH statements.",
		`The AMC workflow execution time window is ${timeWindow.start} through ${timeWindow.end} (${timeWindow.timeZone}); do not invent another date range unless the user explicitly asks for one in SQL filters.`,
		"Do not use PostgreSQL-specific syntax such as date_trunc interval literals if Presto syntax is required.",
	].join("\n");
}

function isTerminalSuccess(execution: AmcWorkflowExecution): boolean {
	return execution.status === "SUCCEEDED";
}
