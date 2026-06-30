import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { ToolsetsInput, ToolsInput } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { MCPClient } from "@mastra/mcp";
import { z } from "zod";
import { executeQuery, explainQuery } from "@/db/index.js";
import { extractSqlAndExplanation } from "@/llm/prompts.js";
import {
	enforceTenantIsolation,
	getApprovalReasons,
	requiresSensitiveApproval,
	sanitizeDatabaseError,
	sanitizeSensitiveData,
	securityRequestContextSchema,
	validateSql,
} from "@/safety/index.js";
import type {
	DatabaseSchema,
	QcpConfig,
	SecureQueryError,
	SecureQueryResult,
	SecurityRequestContext,
	SqlGenerationResult,
} from "@/types/index.js";
import type { DatabaseAgentType } from "./database-agent.js";
import {
	createDatabaseTools,
	type DatabaseExplainExecutor,
	type DatabaseQueryExecutor,
	formatSchemaForDatabaseAgent,
} from "./database-tools.js";
import { createMastraModelConfig } from "./model-config.js";
import { PostgresAgent, type PostgresAgentConfig } from "./postgres-agent.js";

const _safetyReportSchema = z.object({
	safe: z.boolean(),
	readOnly: z.boolean(),
	allowedStatement: z.boolean(),
	limitApplied: z.boolean(),
	errors: z.array(z.string()),
	warnings: z.array(z.string()),
	processedSql: z.string(),
	statementType: z.string(),
});

const _tenantIsolationReportSchema = z.object({
	safe: z.boolean(),
	errors: z.array(z.string()),
	warnings: z.array(z.string()),
	processedSql: z.string(),
	injectedPredicates: z.array(z.string()),
	scopedTables: z.array(z.string()),
});

const _approvalReasonSchema = z.object({
	type: z.enum(["sensitive_table", "large_scan", "no_limit", "high_cost"]),
	detail: z.string(),
});

const _queryResultSchema = z.object({
	rows: z.array(z.record(z.string(), z.unknown())),
	rowCount: z.number(),
	fields: z.array(z.string()),
	executionTimeMs: z.number(),
	explainPlan: z.string().optional(),
});

const prismaContextSchema = z.object({
	databaseName: z.string(),
	tableCount: z.number(),
	schemaContext: z.string(),
	prismaSchemaPath: z.string().optional(),
	prismaDatasourceName: z.string().optional(),
	prismaSchema: z.string().optional(),
});

export type PrismaQueryExecutor = DatabaseQueryExecutor;

export type PrismaExplainExecutor = DatabaseExplainExecutor;

export interface PrismaAgentConfig<TAgentId extends string = string>
	extends PostgresAgentConfig<TAgentId> {
	readonly databaseUrl?: string;
	readonly schema?: DatabaseSchema;
	readonly prismaSchemaPath?: string;
	readonly datasourceName?: string;
	readonly sensitiveTablePatterns?: readonly string[];
	readonly queryExecutor?: PrismaQueryExecutor;
	readonly explainExecutor?: PrismaExplainExecutor;
}

export class PrismaAgent<
	TAgentId extends string = string,
> extends PostgresAgent<TAgentId> {
	protected readonly prismaConfig: PrismaAgentConfig<TAgentId>;

	public constructor(config: PrismaAgentConfig<TAgentId>) {
		super({
			...config,
			tools: {
				...(config.tools ?? {}),
				...(config.databaseUrl && config.schema
					? createPrismaTools({
							databaseUrl: config.databaseUrl,
							schema: config.schema,
							prismaSchemaPath: config.prismaSchemaPath,
							prismaDatasourceName: config.datasourceName,
							sensitiveTablePatterns: config.sensitiveTablePatterns,
							queryExecutor: config.queryExecutor,
							explainExecutor: config.explainExecutor,
						})
					: {}),
			},
		});
		this.prismaConfig = config;
	}

	public override getDatabaseType(): DatabaseAgentType {
		return "prisma";
	}

	protected override getPostgresProviderInstructions(): string[] {
		return [
			"Treat Prisma schema, models, relations, enums, and datasource metadata as the preferred application-level database context when available.",
			"Map natural-language requests to the underlying PostgreSQL schema without ignoring Prisma model names or relation names.",
			"Call out differences between Prisma model names and physical table or column names when they affect the answer.",
			...this.getPrismaContextInstructions(),
		];
	}

	protected getPrismaContextInstructions(): string[] {
		return [
			this.prismaConfig.prismaSchemaPath
				? `Prisma schema path: ${this.prismaConfig.prismaSchemaPath}.`
				: "",
			this.prismaConfig.datasourceName
				? `Prisma datasource name: ${this.prismaConfig.datasourceName}.`
				: "",
		].filter((instruction) => instruction.length > 0);
	}
}

export interface CreatePrismaToolsOptions {
	readonly databaseUrl: string;
	readonly schema: DatabaseSchema;
	readonly prismaSchemaPath?: string;
	readonly prismaDatasourceName?: string;
	readonly sensitiveTablePatterns?: readonly string[];
	readonly queryExecutor?: PrismaQueryExecutor;
	readonly explainExecutor?: PrismaExplainExecutor;
}

export function createPrismaTools(
	options: CreatePrismaToolsOptions,
): ToolsInput {
	return {
		...createDatabaseTools({
			databaseUrl: options.databaseUrl,
			schema: options.schema,
			prismaSchemaPath: options.prismaSchemaPath,
			sensitiveTablePatterns: options.sensitiveTablePatterns,
			queryExecutor: options.queryExecutor,
			explainExecutor: options.explainExecutor,
			enforceTenantIsolation: true,
		}),
		qcp_read_prisma_context: createTool({
			id: "qcp_read_prisma_context",
			description:
				"Read local qcp schema context and Prisma schema text when a Prisma schema path is configured.",
			inputSchema: z.object({}),
			outputSchema: prismaContextSchema,
			mcp: {
				annotations: {
					title: "Read Prisma Context",
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: false,
				},
			},
			execute: async () => {
				const prismaSchema =
					options.prismaSchemaPath && existsSync(options.prismaSchemaPath)
						? readFileSync(options.prismaSchemaPath, "utf-8")
						: undefined;

				return {
					databaseName: options.schema.databaseName,
					tableCount: options.schema.tableCount,
					schemaContext: formatSchemaForDatabaseAgent(options.schema),
					prismaSchemaPath: options.prismaSchemaPath,
					prismaDatasourceName: options.prismaDatasourceName,
					prismaSchema,
				};
			},
		}),
	};
}

export interface SecurePrismaReadOptions {
	readonly databaseUrl: string;
	readonly schema: DatabaseSchema;
	readonly queryExecutor?: PrismaQueryExecutor;
	readonly sensitiveTablePatterns?: readonly string[];
}

export interface SecurePrismaExplainOptions {
	readonly databaseUrl: string;
	readonly schema: DatabaseSchema;
	readonly explainExecutor?: PrismaExplainExecutor;
	readonly sensitiveTablePatterns?: readonly string[];
}

type SecurePrismaReadOutput = SecureQueryResult | SecureQueryError;

type SecurePrismaExplainOutput =
	| {
			readonly ok: true;
			readonly safety: ReturnType<typeof validateSql>;
			readonly isolation: ReturnType<typeof enforceTenantIsolation>;
			readonly plan: string;
			readonly estimatedRows: number;
			readonly approvalReasons: ReturnType<typeof getApprovalReasons>;
	  }
	| SecureQueryError;

interface SecureBaseSuccess {
	readonly ok: true;
	readonly safety: ReturnType<typeof validateSql>;
	readonly isolation: ReturnType<typeof enforceTenantIsolation>;
	readonly approvalReasons: ReturnType<typeof getApprovalReasons>;
}

type SecureBaseResult = SecureBaseSuccess | SecureQueryError;

export async function executeSecurePrismaReadQuery(
	options: SecurePrismaReadOptions,
	sql: string,
	context?: unknown,
): Promise<SecurePrismaReadOutput> {
	const base = prepareSecurePrismaQuery(
		sql,
		options.schema,
		options.sensitiveTablePatterns ?? [],
		context,
	);
	if (!base.ok) return base;

	const queryExecutor = options.queryExecutor ?? executeQuery;
	try {
		const result = await queryExecutor(
			options.databaseUrl,
			base.isolation.processedSql,
		);
		return {
			ok: true,
			safety: base.safety,
			isolation: base.isolation,
			result: sanitizeSensitiveData(result),
			approvalReasons: base.approvalReasons,
		};
	} catch (err: unknown) {
		return {
			ok: false,
			safety: base.safety,
			isolation: base.isolation,
			error: sanitizeDatabaseError(err),
			approvalReasons: base.approvalReasons,
		};
	}
}

export async function executeSecurePrismaExplainQuery(
	options: SecurePrismaExplainOptions,
	sql: string,
	context?: unknown,
): Promise<SecurePrismaExplainOutput> {
	const base = prepareSecurePrismaQuery(
		sql,
		options.schema,
		options.sensitiveTablePatterns ?? [],
		context,
	);
	if (!base.ok) return base;

	const explainExecutor = options.explainExecutor ?? explainQuery;
	try {
		const explain = await explainExecutor(
			options.databaseUrl,
			base.isolation.processedSql,
		);
		const approvalReasons = getApprovalReasons(
			base.isolation.processedSql,
			base.safety,
			[...(options.sensitiveTablePatterns ?? [])],
			explain.estimatedRows,
		);
		return {
			ok: true,
			safety: base.safety,
			isolation: base.isolation,
			plan: sanitizeSensitiveData(explain.plan),
			estimatedRows: explain.estimatedRows,
			approvalReasons,
		};
	} catch (err: unknown) {
		return {
			ok: false,
			safety: base.safety,
			isolation: base.isolation,
			error: sanitizeDatabaseError(err),
			approvalReasons: base.approvalReasons,
		};
	}
}

function prepareSecurePrismaQuery(
	sql: string,
	schema: DatabaseSchema,
	sensitiveTablePatterns: readonly string[],
	context?: unknown,
): SecureBaseResult {
	const safety = validateSql(sql);
	if (!safety.safe) {
		return {
			ok: false,
			safety,
			error: safety.errors[0] ?? "SQL rejected by qcp safety policy.",
			approvalReasons: [],
		};
	}

	const securityContext = extractSecurityRequestContext(context);
	if (!securityContext) {
		return {
			ok: false,
			safety,
			error: "Trusted tenant context is required.",
			approvalReasons: [],
		};
	}

	const isolation = enforceTenantIsolation(
		safety.processedSql,
		schema,
		securityContext,
	);
	if (!isolation.safe) {
		return {
			ok: false,
			safety,
			isolation,
			error:
				isolation.errors[0] ?? "Query rejected by qcp tenant isolation policy.",
			approvalReasons: [],
		};
	}

	return {
		ok: true,
		safety,
		isolation,
		approvalReasons: getApprovalReasons(isolation.processedSql, safety, [
			...sensitiveTablePatterns,
		]),
	};
}

interface ApprovalCheckOptions {
	readonly sql: string;
	readonly databaseUrl: string;
	readonly schema: DatabaseSchema;
	readonly sensitiveTablePatterns: readonly string[];
	readonly explainExecutor: PrismaExplainExecutor;
	readonly requestContext?: unknown;
}

async function _shouldRequirePrismaToolApproval(
	options: ApprovalCheckOptions,
): Promise<boolean> {
	const safety = validateSql(options.sql);
	if (!safety.safe) return false;

	const securityContext = extractSecurityRequestContext({
		requestContext: options.requestContext,
	});
	if (!securityContext) return false;

	const isolation = enforceTenantIsolation(
		safety.processedSql,
		options.schema,
		securityContext,
	);
	if (!isolation.safe) return false;

	if (
		requiresSensitiveApproval(isolation.processedSql, safety, [
			...options.sensitiveTablePatterns,
		])
	) {
		return true;
	}

	try {
		const explain = await options.explainExecutor(
			options.databaseUrl,
			isolation.processedSql,
		);
		const reasons = getApprovalReasons(
			isolation.processedSql,
			safety,
			[...options.sensitiveTablePatterns],
			explain.estimatedRows,
		);
		return reasons.some((reason) => reason.type === "high_cost");
	} catch {
		return true;
	}
}

interface RequestContextLike {
	get(key: string): unknown;
}

function extractSecurityRequestContext(
	context?: unknown,
): SecurityRequestContext | null {
	const requestContext = getRecordValue(context, "requestContext") ?? context;
	const candidates: unknown[] = [];

	if (isRequestContextLike(requestContext)) {
		candidates.push({
			tenantId: requestContext.get("tenantId"),
			userId: requestContext.get("userId"),
		});
	}

	const all = getRecordValue(requestContext, "all");
	if (all) candidates.push(all);
	candidates.push(requestContext);

	for (const candidate of candidates) {
		const result = securityRequestContextSchema.safeParse(candidate);
		if (result.success) return result.data;
	}

	return null;
}

function isRequestContextLike(value: unknown): value is RequestContextLike {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { get?: unknown }).get === "function"
	);
}

function getRecordValue(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null) return undefined;
	return (value as Record<string, unknown>)[key];
}

interface ToolTransformPayload {
	readonly input?: unknown;
	readonly output?: unknown;
}

function _sanitizedToolModelOutput(output: unknown): {
	readonly type: "json";
	readonly value: unknown;
} {
	return {
		type: "json",
		value: sanitizeSensitiveData(output),
	};
}

function _secureToolTransform(): {
	readonly display: {
		readonly input: (payload: ToolTransformPayload) => Record<string, string>;
		readonly output: (payload: ToolTransformPayload) => unknown;
		readonly error: () => Record<string, string>;
	};
	readonly transcript: {
		readonly input: (payload: ToolTransformPayload) => Record<string, string>;
		readonly output: (payload: ToolTransformPayload) => unknown;
		readonly error: () => Record<string, string>;
	};
} {
	return {
		display: {
			input: redactedToolInput,
			output: ({ output }) => sanitizeSensitiveData(output),
			error: sanitizedToolError,
		},
		transcript: {
			input: redactedToolInput,
			output: ({ output }) => sanitizeSensitiveData(output),
			error: sanitizedToolError,
		},
	};
}

function redactedToolInput(
	_payload: ToolTransformPayload,
): Record<string, string> {
	return { sql: "[REDACTED_SQL]" };
}

function sanitizedToolError(): Record<string, string> {
	return { message: sanitizeDatabaseError(undefined) };
}

export interface PrismaMcpToolsetsResult {
	readonly toolsets: ToolsetsInput;
	readonly errors: Record<string, string>;
	readonly disconnect: () => Promise<void>;
}

export interface PrismaMcpToolsetsClient {
	listToolsetsWithErrors(): Promise<{
		toolsets: ToolsetsInput;
		errors: Record<string, string>;
	}>;
	disconnect(): Promise<void>;
}

export type PrismaMcpToolsetsClientFactory = (
	databaseUrl: string,
) => PrismaMcpToolsetsClient;

export async function loadPrismaMcpToolsets(
	databaseUrl: string,
	clientFactory: PrismaMcpToolsetsClientFactory = createPrismaMcpClient,
): Promise<PrismaMcpToolsetsResult> {
	let client: PrismaMcpToolsetsClient | null = null;

	try {
		client = clientFactory(databaseUrl);
		const { toolsets, errors } = await client.listToolsetsWithErrors();
		return {
			toolsets,
			errors,
			disconnect: async () => {
				await client?.disconnect();
			},
		};
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			toolsets: {},
			errors: { prisma: message },
			disconnect: async () => {
				await client?.disconnect().catch(() => {});
			},
		};
	}
}

function createPrismaMcpClient(databaseUrl: string): PrismaMcpToolsetsClient {
	return new MCPClient({
		id: `qcp-prisma-${randomUUID()}`,
		servers: {
			prisma: {
				command: "prisma",
				args: ["mcp"],
				env: {
					...stringProcessEnv(),
					PRISMA_DATABASE_URL: databaseUrl,
				},
				forwardInstructions: false,
				requireToolApproval: ({ annotations }) =>
					annotations?.readOnlyHint !== true,
			},
		},
		timeout: 15_000,
	});
}

export interface GeneratePrismaSqlOptions {
	readonly question: string;
	readonly schema: DatabaseSchema;
	readonly config: QcpConfig;
	readonly databaseUrl: string;
	readonly prismaSchemaPath?: string;
	readonly prismaDatasourceName?: string;
	readonly debug?: boolean;
}

export async function generateSqlWithPrismaAgent(
	options: GeneratePrismaSqlOptions,
): Promise<SqlGenerationResult> {
	const start = Date.now();
	const model = createMastraModelConfig(options.config);
	const agent = new PrismaAgent({
		id: "qcp-prisma-agent",
		name: "QCP Prisma Agent",
		description:
			"Safely answers natural-language questions about a Prisma Postgres database.",
		model,
		databaseUrl: options.databaseUrl,
		schema: options.schema,
		prismaSchemaPath: options.prismaSchemaPath,
		datasourceName: options.prismaDatasourceName,
		sensitiveTablePatterns: options.config.sensitiveTablePatterns,
		instructions: [
			"Use qcp_read_prisma_context and qcp_validate_sql to improve SQL quality.",
			"Do not call qcp_execute_read_sql while generating SQL for qcp CLI output.",
			"Return exactly one read-only PostgreSQL query wrapped in <sql> tags and a concise explanation wrapped in <explanation> tags.",
			"Never return INSERT, UPDATE, DELETE, DDL, administrative statements, multiple statements, or unbounded exploratory SQL.",
		],
	});

	const mcp = await loadPrismaMcpToolsets(options.databaseUrl);

	try {
		const response = await agent
			.getAgent()
			.generate(buildPrismaAgentPrompt(options), {
				maxSteps: 4,
				activeTools: ["qcp_read_prisma_context", "qcp_validate_sql"],
				toolsets: mcp.toolsets,
				modelSettings: {
					temperature: 0,
				},
			});
		const { sql, explanation } = extractSqlAndExplanation(response.text);

		return {
			sql,
			explanation,
			tokensIn: response.usage?.inputTokens,
			tokensOut: response.usage?.outputTokens,
			latencyMs: Date.now() - start,
		};
	} finally {
		await mcp.disconnect();
	}
}

function buildPrismaAgentPrompt(options: GeneratePrismaSqlOptions): string {
	return `
DATABASE SCHEMA:
${formatSchemaForPrismaAgent(options.schema)}
${formatPrismaConfigForPrompt(options)}

USER QUESTION:
${options.question}

Generate a safe, read-only PostgreSQL query for this Prisma Postgres database.
`.trim();
}

function formatSchemaForPrismaAgent(schema: DatabaseSchema): string {
	const lines = [
		`Database: ${schema.databaseName}`,
		`Tables (${schema.tableCount}):`,
		"",
	];

	for (const table of schema.tables) {
		const tableId =
			table.schema === "public" ? table.name : `${table.schema}.${table.name}`;
		lines.push(`TABLE ${tableId}`);
		for (const column of table.columns) {
			const flags = [
				column.isPrimaryKey ? "PK" : "",
				column.nullable ? "nullable" : "required",
			].filter((flag) => flag.length > 0);
			lines.push(`  ${column.name}: ${column.type} (${flags.join(", ")})`);
		}
		for (const foreignKey of table.foreignKeys) {
			const referencedTable =
				foreignKey.referencedSchema === "public"
					? foreignKey.referencedTable
					: `${foreignKey.referencedSchema}.${foreignKey.referencedTable}`;
			lines.push(
				`  FK ${foreignKey.column} -> ${referencedTable}.${foreignKey.referencedColumn}`,
			);
		}
		lines.push("");
	}

	return lines.join("\n");
}

function formatPrismaConfigForPrompt(
	options: GeneratePrismaSqlOptions,
): string {
	const lines: string[] = [];
	if (options.prismaSchemaPath) {
		lines.push(`Prisma schema path: ${options.prismaSchemaPath}`);
	}
	if (options.prismaDatasourceName) {
		lines.push(`Prisma datasource name: ${options.prismaDatasourceName}`);
	}
	return lines.length > 0 ? `\nPRISMA CONFIG:\n${lines.join("\n")}` : "";
}

function stringProcessEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === "string") {
			env[key] = value;
		}
	}
	return env;
}
