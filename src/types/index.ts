// ─── Config ───────────────────────────────────────────────────────────────────

export type ProviderName = "gemini" | "openai" | "anthropic" | "ollama";

export type DatabaseType =
	| "prisma-postgres"
	| "neon"
	| "supabase"
	| "oracle-postgres"
	| "other-postgres";

export interface DatabaseConnectionConfig {
	id: string;
	name: string;
	databaseType: DatabaseType;
	databaseUrl: string;
	prismaSchemaPath?: string;
	prismaDatasourceName?: string;
	createdAt: string;
	updatedAt: string;
	privacyPolicy?: PostgresPrivacyPolicy;
}

export interface ActiveDatabaseConnection {
	id: string;
	name: string;
	databaseType: DatabaseType;
	databaseUrl: string;
	prismaSchemaPath?: string;
	prismaDatasourceName?: string;
}

export interface ApiKeys {
	gemini?: string;
	openai?: string;
	anthropic?: string;
}

export interface QcpWebAuthConfig {
	passcodeHash: string;
	passcodeSalt: string;
	sessionTokenHash?: string;
	sessionExpiresAt?: string;
	createdAt: string;
	updatedAt: string;
}

export interface QcpConfig {
	version: string;
	installId: string;
	databaseConnections: DatabaseConnectionConfig[];
	activeDatabaseId?: string;
	databaseType: DatabaseType;
	databaseUrl?: string;
	prismaSchemaPath?: string;
	prismaDatasourceName?: string;
	provider: ProviderName;
	model: string;
	telemetry: boolean;
	safetyLevel: SafetyLevel;
	safeMode: boolean;
	showSql: boolean;
	showMetrics: boolean;
	sensitiveTablePatterns: string[];
	ollamaHost?: string;
	apiKeys: ApiKeys;
	webAuth?: QcpWebAuthConfig;
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

export interface SchemaCatalogEntry {
	connectionId: string;
	connectionName: string;
	databaseType: DatabaseType;
	databaseName: string;
	scannedAt: string;
	schema: DatabaseSchema;
}

export interface SchemaCatalog {
	version: string;
	schemas: SchemaCatalogEntry[];
}

// ─── Safety ───────────────────────────────────────────────────────────────────

export type SafetyLevel = "low" | "standard" | "strict";

export interface SafetyReport {
	safe: boolean;
	readOnly: boolean;
	allowedStatement: boolean;
	limitApplied: boolean;
	errors: string[];
	warnings: string[];
	processedSql: string;
	statementType: string;
	privacyFindings?: PrivacySafetyFinding[];
}

export type PrivacySafetyFindingType =
	| "sensitive_column"
	| "minimum_cohort"
	| "unsafe_function"
	| "unsafe_clause";

export interface PrivacySafetyFinding {
	type: PrivacySafetyFindingType;
	detail: string;
	object?: string;
}

export interface PostgresPrivacyPolicy {
	sensitiveColumns: string[];
	allowedSensitiveViews: string[];
	safeFunctions: string[];
	minimumCohortSize: number;
}

export type PostgresPrivacyPostureSeverity = "info" | "warning" | "critical";

export interface PostgresPrivacyPostureFinding {
	check: string;
	severity: PostgresPrivacyPostureSeverity;
	detail: string;
	remediation: string;
}

export interface PostgresPrivacyPostureReport {
	role: string;
	findings: PostgresPrivacyPostureFinding[];
	checkedAt: string;
}

export interface SecurityRequestContext {
	tenantId: string;
	userId: string;
}

export interface TenantIsolationReport {
	safe: boolean;
	errors: string[];
	warnings: string[];
	processedSql: string;
	injectedPredicates: string[];
	scopedTables: string[];
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

export interface SecureQueryResult {
	ok: true;
	safety: SafetyReport;
	isolation: TenantIsolationReport;
	result: QueryResult;
	approvalReasons: ApprovalReason[];
}

export interface SecureQueryError {
	ok: false;
	safety: SafetyReport;
	isolation?: TenantIsolationReport;
	error: string;
	approvalReasons: ApprovalReason[];
}

export type PromptViolationCategory = "privacy" | "security" | "safety";

export interface PromptViolationReport {
	category: PromptViolationCategory;
	title: string;
	message: string;
	detail: string;
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
	type:
		| "sensitive_table"
		| "large_scan"
		| "no_limit"
		| "high_cost"
		| "strict_mode";
	detail: string;
}
