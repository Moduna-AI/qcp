import type {
	AmazonMarketingCloudConnectionConfig,
	DatabaseSchema,
	QueryResult,
	SqlGenerationResult,
} from "@/types/index.js";

export type AmcWorkflowExecutionStatus =
	| "PENDING"
	| "RUNNING"
	| "SUCCEEDED"
	| "FAILED"
	| "CANCELLED";

export interface AmcDataSourceColumn {
	readonly name: string;
	readonly description?: string;
	readonly columnType?: string;
	readonly dataType?: string;
}

export interface AmcDataSource {
	readonly dataSourceId: string;
	readonly name?: string;
	readonly description?: string;
	readonly columns?: readonly AmcDataSourceColumn[];
}

export interface AmcWorkflowExecution {
	readonly workflowExecutionId: string;
	readonly workflowId?: string;
	readonly status: AmcWorkflowExecutionStatus;
	readonly outputS3URI?: string;
	readonly createdTime?: string;
	readonly updatedTime?: string;
	readonly sqlQuery?: string;
	readonly errorReason?: string;
	readonly warnings?: readonly string[];
}

export interface AmcDownloadUrlsPage {
	readonly downloadUrls: readonly string[];
	readonly metadataDownloadUrls: readonly string[];
	readonly nextToken?: string;
}

export interface AmcExplicitTimeWindow {
	readonly type: "EXPLICIT";
	readonly start: string;
	readonly end: string;
	readonly timeZone: string;
}

export type AmcTimeWindow = AmcExplicitTimeWindow;

export interface AmcRunQuestionOptions {
	readonly dryRun?: boolean;
	readonly exportPath?: string;
	readonly since?: string;
	readonly until?: string;
	readonly timeZone?: string;
	readonly limit?: number;
	readonly pollIntervalMs?: number;
	readonly onPoll?: (execution: AmcWorkflowExecution) => void;
	readonly shouldStopPolling?: () => boolean;
}

export interface AmcRunQuestionResult {
	readonly question: string;
	readonly sql: string;
	readonly explanation: string;
	readonly sqlGeneration: SqlGenerationResult;
	readonly dryRunExecution: AmcWorkflowExecution;
	readonly execution?: AmcWorkflowExecution;
	readonly timeWindow: AmcTimeWindow;
	readonly queryResult?: QueryResult;
	readonly exportedFiles: readonly string[];
	readonly stoppedPolling: boolean;
}

export interface AmcConnectionHealth {
	readonly connected: boolean;
	readonly version: string;
	readonly schema?: DatabaseSchema;
	readonly error?: string;
}

export interface ResolvedAmazonMarketingCloudConfig
	extends AmazonMarketingCloudConnectionConfig {
	readonly apiBaseUrl: string;
}
