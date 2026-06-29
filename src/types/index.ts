// ─── Config ───────────────────────────────────────────────────────────────────

export type ProviderName = "gemini" | "openai" | "anthropic" | "ollama";

export type DatabaseType =
	| "prisma-postgres"
	| "neon"
	| "supabase"
	| "oracle-postgres"
	| "other-postgres";

export interface ApiKeys {
	gemini?: string;
	openai?: string;
	anthropic?: string;
}

export interface QcpConfig {
	version: string;
	installId: string;
	databaseType: DatabaseType;
	databaseUrl?: string;
	provider: ProviderName;
	model: string;
	telemetry: boolean;
	safeMode: boolean;
	showSql: boolean;
	showMetrics: boolean;
	sensitiveTablePatterns: string[];
	ollamaHost?: string;
	apiKeys: ApiKeys;
}

// ─── Database Schema ──────────────────────────────────────────────────────────

export interface SchemaColumn {
	name: string;
	type: string;
	nullable: boolean;
	defaultValue?: string | null;
	isPrimaryKey: boolean;
}

export interface SchemaForeignKey {
	constraintName: string;
	column: string;
	referencedTable: string;
	referencedSchema: string;
	referencedColumn: string;
}

export interface SchemaIndex {
	name: string;
	columns: string[];
	unique: boolean;
	primary: boolean;
}

export interface SchemaTable {
	schema: string;
	name: string;
	columns: SchemaColumn[];
	primaryKeys: string[];
	foreignKeys: SchemaForeignKey[];
	indexes: SchemaIndex[];
	estimatedRows?: number;
}

export interface DatabaseSchema {
	scannedAt: string;
	databaseName: string;
	tableCount: number;
	tables: SchemaTable[];
}

// ─── Safety ───────────────────────────────────────────────────────────────────

export interface SafetyReport {
	safe: boolean;
	readOnly: boolean;
	allowedStatement: boolean;
	limitApplied: boolean;
	errors: string[];
	warnings: string[];
	processedSql: string;
	statementType: string;
}

// ─── LLM ──────────────────────────────────────────────────────────────────────

export interface SqlGenerationResult {
	sql: string;
	explanation: string;
	tokensIn?: number;
	tokensOut?: number;
	latencyMs: number;
}

export interface SummaryResult {
	summary: string;
	tokensIn?: number;
	tokensOut?: number;
	latencyMs: number;
}

export interface LLMProvider {
	readonly providerName: ProviderName;
	readonly modelName: string;
	generateSql(
		question: string,
		schema: DatabaseSchema,
		onChunk?: (chunk: string) => void,
	): Promise<SqlGenerationResult>;
	generateSummary(
		question: string,
		sql: string,
		results: QueryResult,
		onChunk?: (chunk: string) => void,
	): Promise<SummaryResult>;
	testConnectivity(): Promise<boolean>;
}

// ─── Query ────────────────────────────────────────────────────────────────────

export interface QueryResult {
	rows: Record<string, unknown>[];
	rowCount: number;
	fields: string[];
	executionTimeMs: number;
	explainPlan?: string;
}

export interface QueryMetrics {
	tokensIn: number;
	tokensOut: number;
	totalLatencyMs: number;
	sqlGenerationMs: number;
	executionMs: number;
	summaryMs: number;
	provider: string;
	model: string;
}

// ─── Doctor ───────────────────────────────────────────────────────────────────

export type HealthStatus = "healthy" | "warning" | "error" | "unknown";

export interface DoctorCheck {
	name: string;
	status: HealthStatus;
	value?: string;
	message?: string;
}

export interface DoctorReport {
	version: string;
	timestamp: string;
	overall: HealthStatus;
	checks: {
		installation: DoctorCheck[];
		runtime: DoctorCheck[];
		database: DoctorCheck[];
		llm: DoctorCheck[];
		configuration: DoctorCheck[];
	};
}

// ─── Telemetry ────────────────────────────────────────────────────────────────

export interface TelemetryEvent {
	event: string;
	properties: Record<string, string | number | boolean | null>;
}

// ─── Approval ─────────────────────────────────────────────────────────────────

export interface ApprovalReason {
	type: "sensitive_table" | "large_scan" | "no_limit" | "high_cost";
	detail: string;
}
