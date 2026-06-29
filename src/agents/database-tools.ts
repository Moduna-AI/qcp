import { existsSync, readFileSync } from "node:fs";
import type { ToolsInput } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { executeQuery, explainQuery } from "@/db/index.js";
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
	ApprovalReason,
	DatabaseSchema,
	QueryResult,
	SecureQueryError,
	SecurityRequestContext,
} from "@/types/index.js";

export type DatabaseQueryExecutor = (
	databaseUrl: string,
	sql: string,
) => Promise<QueryResult>;

export type DatabaseExplainExecutor = (
	databaseUrl: string,
	sql: string,
) => Promise<{ plan: string; estimatedRows: number }>;

export type DatabaseToolApprovalHandler = (
	reasons: ApprovalReason[],
	sql: string,
) => Promise<boolean>;

const safetyReportSchema = z.object({
	safe: z.boolean(),
	readOnly: z.boolean(),
	allowedStatement: z.boolean(),
	limitApplied: z.boolean(),
	errors: z.array(z.string()),
	warnings: z.array(z.string()),
	processedSql: z.string(),
	statementType: z.string(),
});

const tenantIsolationReportSchema = z.object({
	safe: z.boolean(),
	errors: z.array(z.string()),
	warnings: z.array(z.string()),
	processedSql: z.string(),
	injectedPredicates: z.array(z.string()),
	scopedTables: z.array(z.string()),
});

const approvalReasonSchema = z.object({
	type: z.enum(["sensitive_table", "large_scan", "no_limit", "high_cost"]),
	detail: z.string(),
});

const queryResultSchema = z.object({
	rows: z.array(z.record(z.string(), z.unknown())),
	rowCount: z.number(),
	fields: z.array(z.string()),
	executionTimeMs: z.number(),
	explainPlan: z.string().optional(),
});

const databaseContextSchema = z.object({
	databaseName: z.string(),
	tableCount: z.number(),
	schemaContext: z.string(),
	prismaSchemaPath: z.string().optional(),
	prismaSchema: z.string().optional(),
});

export interface CreateDatabaseToolsOptions {
	readonly databaseUrl: string;
	readonly schema: DatabaseSchema;
	readonly sensitiveTablePatterns?: readonly string[];
	readonly queryExecutor?: DatabaseQueryExecutor;
	readonly explainExecutor?: DatabaseExplainExecutor;
	readonly enforceTenantIsolation?: boolean;
	readonly prismaSchemaPath?: string;
	readonly approvalHandler?: DatabaseToolApprovalHandler;
}

export function createDatabaseTools(
	options: CreateDatabaseToolsOptions,
): ToolsInput {
	const queryExecutor = options.queryExecutor ?? executeQuery;
	const explainExecutor = options.explainExecutor ?? explainQuery;
	const sensitiveTablePatterns = [...(options.sensitiveTablePatterns ?? [])];

	return {
		qcp_read_database_context: createTool({
			id: "qcp_read_database_context",
			description:
				"Read local qcp database schema context for answering questions about available schemas, tables, columns, indexes, and relationships.",
			inputSchema: z.object({}),
			outputSchema: databaseContextSchema,
			mcp: {
				annotations: {
					title: "Read Database Context",
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
					prismaSchema,
				};
			},
		}),
		qcp_validate_sql: createTool({
			id: "qcp_validate_sql",
			description:
				"Validate PostgreSQL SQL with qcp's AST safety policy. Only SELECT, WITH, and safe EXPLAIN statements are accepted.",
			inputSchema: z.object({
				sql: z.string().min(1),
			}),
			outputSchema: safetyReportSchema,
			mcp: {
				annotations: {
					title: "Validate SQL",
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: false,
				},
			},
			execute: async ({ sql }) => validateSql(sql),
		}),
		qcp_execute_read_sql: createTool({
			id: "qcp_execute_read_sql",
			description:
				"Execute a read-only PostgreSQL query only after qcp AST validation succeeds. Rejected SQL is returned as a structured safety error.",
			strict: true,
			inputSchema: z.object({
				sql: z.string().min(1),
			}),
			requestContextSchema: options.enforceTenantIsolation
				? securityRequestContextSchema
				: undefined,
			outputSchema: z.discriminatedUnion("ok", [
				z.object({
					ok: z.literal(true),
					safety: safetyReportSchema,
					isolation: tenantIsolationReportSchema.optional(),
					result: queryResultSchema,
					approvalReasons: z.array(approvalReasonSchema),
				}),
				z.object({
					ok: z.literal(false),
					safety: safetyReportSchema,
					isolation: tenantIsolationReportSchema.optional(),
					error: z.string(),
					approvalReasons: z.array(approvalReasonSchema),
				}),
			]),
			requireApproval: async ({ sql }, context) =>
				shouldRequireDatabaseToolApproval({
					sql,
					databaseUrl: options.databaseUrl,
					schema: options.schema,
					sensitiveTablePatterns,
					explainExecutor,
					enforceTenantIsolation: options.enforceTenantIsolation ?? false,
					requestContext: context?.requestContext,
				}),
			toModelOutput: sanitizedToolModelOutput,
			transform: secureToolTransform(),
			mcp: {
				annotations: {
					title: "Execute Read SQL",
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: false,
					openWorldHint: false,
				},
			},
			execute: async ({ sql }, context) =>
				executeSecureReadQuery(
					{
						databaseUrl: options.databaseUrl,
						schema: options.schema,
						queryExecutor,
						sensitiveTablePatterns,
						enforceTenantIsolation: options.enforceTenantIsolation ?? false,
						approvalHandler: options.approvalHandler,
					},
					sql,
					context,
				),
		}),
		qcp_explain_read_sql: createTool({
			id: "qcp_explain_read_sql",
			description:
				"Run EXPLAIN for a read-only PostgreSQL query only after qcp AST validation succeeds.",
			strict: true,
			inputSchema: z.object({
				sql: z.string().min(1),
			}),
			requestContextSchema: options.enforceTenantIsolation
				? securityRequestContextSchema
				: undefined,
			outputSchema: z.discriminatedUnion("ok", [
				z.object({
					ok: z.literal(true),
					safety: safetyReportSchema,
					isolation: tenantIsolationReportSchema.optional(),
					plan: z.string(),
					estimatedRows: z.number(),
					approvalReasons: z.array(approvalReasonSchema),
				}),
				z.object({
					ok: z.literal(false),
					safety: safetyReportSchema,
					isolation: tenantIsolationReportSchema.optional(),
					error: z.string(),
					approvalReasons: z.array(approvalReasonSchema),
				}),
			]),
			requireApproval: async ({ sql }, context) =>
				shouldRequireDatabaseToolApproval({
					sql,
					databaseUrl: options.databaseUrl,
					schema: options.schema,
					sensitiveTablePatterns,
					explainExecutor,
					enforceTenantIsolation: options.enforceTenantIsolation ?? false,
					requestContext: context?.requestContext,
				}),
			toModelOutput: sanitizedToolModelOutput,
			transform: secureToolTransform(),
			mcp: {
				annotations: {
					title: "Explain Read SQL",
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: false,
				},
			},
			execute: async ({ sql }, context) =>
				executeSecureExplainQuery(
					{
						databaseUrl: options.databaseUrl,
						schema: options.schema,
						explainExecutor,
						sensitiveTablePatterns,
						enforceTenantIsolation: options.enforceTenantIsolation ?? false,
						approvalHandler: options.approvalHandler,
					},
					sql,
					context,
				),
		}),
	};
}

export interface SecureReadOptions {
	readonly databaseUrl: string;
	readonly schema: DatabaseSchema;
	readonly queryExecutor?: DatabaseQueryExecutor;
	readonly sensitiveTablePatterns?: readonly string[];
	readonly enforceTenantIsolation?: boolean;
	readonly approvalHandler?: DatabaseToolApprovalHandler;
}

export interface SecureExplainOptions {
	readonly databaseUrl: string;
	readonly schema: DatabaseSchema;
	readonly explainExecutor?: DatabaseExplainExecutor;
	readonly sensitiveTablePatterns?: readonly string[];
	readonly enforceTenantIsolation?: boolean;
	readonly approvalHandler?: DatabaseToolApprovalHandler;
}

export type SecureReadOutput =
	| {
			readonly ok: true;
			readonly safety: ReturnType<typeof validateSql>;
			readonly isolation?: ReturnType<typeof enforceTenantIsolation>;
			readonly result: QueryResult;
			readonly approvalReasons: ReturnType<typeof getApprovalReasons>;
	  }
	| SecureQueryError;

export type SecureExplainOutput =
	| {
			readonly ok: true;
			readonly safety: ReturnType<typeof validateSql>;
			readonly isolation?: ReturnType<typeof enforceTenantIsolation>;
			readonly plan: string;
			readonly estimatedRows: number;
			readonly approvalReasons: ReturnType<typeof getApprovalReasons>;
	  }
	| SecureQueryError;

interface SecureBaseSuccess {
	readonly ok: true;
	readonly safety: ReturnType<typeof validateSql>;
	readonly isolation?: ReturnType<typeof enforceTenantIsolation>;
	readonly processedSql: string;
	readonly approvalReasons: ReturnType<typeof getApprovalReasons>;
}

type SecureBaseResult = SecureBaseSuccess | SecureQueryError;

export async function executeSecureReadQuery(
	options: SecureReadOptions,
	sql: string,
	context?: unknown,
): Promise<SecureReadOutput> {
	const base = prepareSecureQuery(
		sql,
		options.schema,
		options.sensitiveTablePatterns ?? [],
		options.enforceTenantIsolation ?? false,
		context,
	);
	if (!base.ok) return base;

	const approved = await confirmApprovalIfNeeded(
		base.approvalReasons,
		base.processedSql,
		options.approvalHandler,
	);
	if (!approved) {
		return {
			ok: false,
			safety: base.safety,
			isolation: base.isolation,
			error: "Query requires approval before execution.",
			approvalReasons: base.approvalReasons,
		};
	}

	const queryExecutor = options.queryExecutor ?? executeQuery;
	try {
		const result = await queryExecutor(options.databaseUrl, base.processedSql);
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

export async function executeSecureExplainQuery(
	options: SecureExplainOptions,
	sql: string,
	context?: unknown,
): Promise<SecureExplainOutput> {
	const base = prepareSecureQuery(
		sql,
		options.schema,
		options.sensitiveTablePatterns ?? [],
		options.enforceTenantIsolation ?? false,
		context,
	);
	if (!base.ok) return base;

	const explainExecutor = options.explainExecutor ?? explainQuery;
	try {
		const explain = await explainExecutor(
			options.databaseUrl,
			base.processedSql,
		);
		const approvalReasons = getApprovalReasons(
			base.processedSql,
			base.safety,
			[...(options.sensitiveTablePatterns ?? [])],
			explain.estimatedRows,
		);
		const approved = await confirmApprovalIfNeeded(
			approvalReasons,
			base.processedSql,
			options.approvalHandler,
		);
		if (!approved) {
			return {
				ok: false,
				safety: base.safety,
				isolation: base.isolation,
				error: "Query requires approval before EXPLAIN.",
				approvalReasons,
			};
		}

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

function prepareSecureQuery(
	sql: string,
	schema: DatabaseSchema,
	sensitiveTablePatterns: readonly string[],
	shouldEnforceTenantIsolation: boolean,
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

	if (!shouldEnforceTenantIsolation) {
		return {
			ok: true,
			safety,
			processedSql: safety.processedSql,
			approvalReasons: getApprovalReasons(safety.processedSql, safety, [
				...sensitiveTablePatterns,
			]),
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
		processedSql: isolation.processedSql,
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
	readonly explainExecutor: DatabaseExplainExecutor;
	readonly enforceTenantIsolation: boolean;
	readonly requestContext?: unknown;
}

async function shouldRequireDatabaseToolApproval(
	options: ApprovalCheckOptions,
): Promise<boolean> {
	const safety = validateSql(options.sql);
	if (!safety.safe) return false;

	const processedSql = options.enforceTenantIsolation
		? getTenantScopedSql(options.sql, options.schema, options.requestContext)
		: safety.processedSql;
	if (!processedSql) return false;

	if (
		requiresSensitiveApproval(processedSql, safety, [
			...options.sensitiveTablePatterns,
		])
	) {
		return true;
	}

	try {
		const explain = await options.explainExecutor(
			options.databaseUrl,
			processedSql,
		);
		const reasons = getApprovalReasons(
			processedSql,
			safety,
			[...options.sensitiveTablePatterns],
			explain.estimatedRows,
		);
		return reasons.some((reason) => reason.type === "high_cost");
	} catch {
		return true;
	}
}

function getTenantScopedSql(
	sql: string,
	schema: DatabaseSchema,
	requestContext?: unknown,
): string | null {
	const safety = validateSql(sql);
	if (!safety.safe) return null;

	const securityContext = extractSecurityRequestContext({
		requestContext,
	});
	if (!securityContext) return null;

	const isolation = enforceTenantIsolation(
		safety.processedSql,
		schema,
		securityContext,
	);
	if (!isolation.safe) return null;

	return isolation.processedSql;
}

async function confirmApprovalIfNeeded(
	reasons: readonly ApprovalReason[],
	sql: string,
	approvalHandler?: DatabaseToolApprovalHandler,
): Promise<boolean> {
	if (reasons.length === 0) return true;
	if (!approvalHandler) return false;
	return approvalHandler([...reasons], sql);
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

function sanitizedToolModelOutput(output: unknown): {
	readonly type: "json";
	readonly value: unknown;
} {
	return {
		type: "json",
		value: sanitizeSensitiveData(output),
	};
}

function secureToolTransform(): {
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

export function formatSchemaForDatabaseAgent(schema: DatabaseSchema): string {
	const lines = [
		`Database: ${schema.databaseName}`,
		`Tables (${schema.tableCount}):`,
		"",
	];

	for (const table of schema.tables) {
		const tableId =
			table.schema === "public" ? table.name : `${table.schema}.${table.name}`;
		lines.push(`- ${tableId}`);
		lines.push(
			`  Columns: ${table.columns.map((column) => `${column.name} ${column.type}`).join(", ")}`,
		);
		if (table.primaryKeys.length > 0) {
			lines.push(`  Primary key: ${table.primaryKeys.join(", ")}`);
		}
		if (table.foreignKeys.length > 0) {
			lines.push(
				`  Foreign keys: ${table.foreignKeys
					.map(
						(fk) =>
							`${fk.column} -> ${fk.referencedSchema}.${fk.referencedTable}.${fk.referencedColumn}`,
					)
					.join("; ")}`,
			);
		}
	}

	return lines.join("\n");
}
