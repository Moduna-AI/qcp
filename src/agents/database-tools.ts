import { existsSync, readFileSync } from "node:fs";
import type { ToolsInput } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { executeQuery, explainQuery } from "@/db/index.js";
import {
	type AuditAction,
	type AuditContext,
	type AuditOutcome,
	buildAuditResource,
	extractSqlTables,
	type JsonValue,
	resolveAuditActor,
	writeAuditEvent,
} from "@/logger/audit.js";
import {
	type QueryPerformanceAnalysis,
	QueryPerformanceAnalyzer,
} from "@/performance/query-performance-analyzer.js";
import {
	applyPrivacyEvaluation,
	approvalReasonsForSafetyLevel,
	auditPostgresPrivacyPosture,
	enforceTenantIsolation,
	evaluatePostgresPrivacyPolicy,
	getApprovalReasons,
	requiresSafetyApproval,
	sanitizeDatabaseError,
	sanitizeSensitiveData,
	securityRequestContextSchema,
	validateSql,
} from "@/safety/index.js";
import type { DatabaseSafetyToolKind } from "@/safety/policy.js";
import { DatabaseTransferService } from "@/transfer/database-transfer-service.js";
import type {
	TransferExportRequest,
	TransferImportRequest,
	TransferResult,
} from "@/transfer/types.js";
import type {
	ApprovalReason,
	DatabaseSchema,
	PostgresPrivacyPolicy,
	QueryResult,
	SafetyLevel,
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
	privacyFindings: z
		.array(
			z.object({
				type: z.enum([
					"sensitive_column",
					"minimum_cohort",
					"unsafe_function",
					"unsafe_clause",
				]),
				detail: z.string(),
				object: z.string().optional(),
			}),
		)
		.optional(),
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
	type: z.enum([
		"sensitive_table",
		"large_scan",
		"no_limit",
		"high_cost",
		"strict_mode",
	]),
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

const postgresPrivacyPostureSchema = z.object({
	role: z.string(),
	checkedAt: z.string(),
	findings: z.array(
		z.object({
			check: z.string(),
			severity: z.enum(["info", "warning", "critical"]),
			detail: z.string(),
			remediation: z.string(),
		}),
	),
});

const queryPlanSummarySchema = z.object({
	nodeType: z.string(),
	relationName: z.string().optional(),
	schemaName: z.string().optional(),
	estimatedRows: z.number().optional(),
	totalCost: z.number().optional(),
	startupCost: z.number().optional(),
});

const queryPerformanceFindingSchema = z.object({
	type: z.enum(["missing_index", "select_star", "plan_summary"]),
	severity: z.enum(["info", "warning", "critical"]),
	title: z.string(),
	detail: z.string(),
	table: z.string().optional(),
	columns: z.array(z.string()).optional(),
	suggestionSql: z.string().optional(),
});

const queryPerformanceAnalysisSchema = z.object({
	summary: z.string(),
	plan: queryPlanSummarySchema,
	findings: z.array(queryPerformanceFindingSchema),
	suggestedIndexes: z.array(queryPerformanceFindingSchema),
	warnings: z.array(queryPerformanceFindingSchema),
});

const transferFormatSchema = z.enum([
	"csv",
	"tsv",
	"json",
	"jsonl",
	"parquet",
	"sqlite",
	"pandas",
	"postgres-dump",
]);

const transferResultSchema = z.discriminatedUnion("ok", [
	z.object({
		ok: z.literal(true),
		direction: z.enum(["import", "export"]),
		format: transferFormatSchema,
		filePath: z.string(),
		rowCount: z.number(),
		tableName: z.string().optional(),
		fields: z.array(z.string()).optional(),
		schemaRefreshed: z.boolean().optional(),
	}),
	z.object({
		ok: z.literal(false),
		direction: z.enum(["import", "export"]),
		format: transferFormatSchema.optional(),
		filePath: z.string().optional(),
		error: z.string(),
	}),
]);

export interface CreateDatabaseToolsOptions {
	readonly databaseUrl: string;
	readonly schema: DatabaseSchema;
	readonly privacyPolicy?: PostgresPrivacyPolicy;
	readonly sensitiveTablePatterns?: readonly string[];
	readonly queryExecutor?: DatabaseQueryExecutor;
	readonly explainExecutor?: DatabaseExplainExecutor;
	readonly enforceTenantIsolation?: boolean;
	readonly prismaSchemaPath?: string;
	readonly approvalHandler?: DatabaseToolApprovalHandler;
	readonly safetyLevel?: SafetyLevel;
	readonly auditContext?: AuditContext;
	readonly transferService?: DatabaseTransferService;
	readonly refreshSchemaAfterImport?: () => Promise<void>;
}

export function createDatabaseTools(
	options: CreateDatabaseToolsOptions,
): ToolsInput {
	const queryExecutor = options.queryExecutor ?? executeQuery;
	const explainExecutor = options.explainExecutor ?? explainQuery;
	const safetyLevel = options.safetyLevel ?? "standard";
	const sensitiveTablePatterns = [...(options.sensitiveTablePatterns ?? [])];
	const transferService =
		options.transferService ??
		new DatabaseTransferService({
			databaseUrl: options.databaseUrl,
			schema: options.schema,
			refreshSchema: options.refreshSchemaAfterImport,
			queryExecutor: async (sql) => {
				const output = await executeSecureReadQuery(
					{
						databaseUrl: options.databaseUrl,
						schema: options.schema,
						privacyPolicy: options.privacyPolicy,
						queryExecutor,
						sensitiveTablePatterns,
						approvalHandler: options.approvalHandler,
						safetyLevel,
						auditContext: options.auditContext,
					},
					sql,
				);
				if (!output.ok) {
					return {
						ok: false,
						direction: "export",
						error: output.error,
					} satisfies TransferResult;
				}
				return output.result;
			},
		});

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
		qcp_audit_postgres_privacy_posture: createTool({
			id: "qcp_audit_postgres_privacy_posture",
			description:
				"Audit the active PostgreSQL role and row-level-security posture using read-only catalog queries. Returns advisory findings and never executes DDL.",
			inputSchema: z.object({}),
			outputSchema: postgresPrivacyPostureSchema,
			toModelOutput: sanitizedToolModelOutput,
			mcp: {
				annotations: {
					title: "Audit PostgreSQL Privacy Posture",
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: false,
				},
			},
			execute: async () =>
				auditPostgresPrivacyPosture({
					databaseUrl: options.databaseUrl,
					queryExecutor,
					schema: options.schema,
					privacyPolicy: options.privacyPolicy,
				}),
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
					privacyPolicy: options.privacyPolicy,
					sensitiveTablePatterns,
					explainExecutor,
					safetyLevel,
					enforceTenantIsolation: options.enforceTenantIsolation ?? false,
					requestContext: context?.requestContext,
					toolKind: "read",
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
						privacyPolicy: options.privacyPolicy,
						queryExecutor,
						sensitiveTablePatterns,
						enforceTenantIsolation: options.enforceTenantIsolation ?? false,
						approvalHandler: options.approvalHandler,
						safetyLevel,
						auditContext: options.auditContext,
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
					privacyPolicy: options.privacyPolicy,
					sensitiveTablePatterns,
					explainExecutor,
					safetyLevel,
					enforceTenantIsolation: options.enforceTenantIsolation ?? false,
					requestContext: context?.requestContext,
					toolKind: "explain",
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
						privacyPolicy: options.privacyPolicy,
						explainExecutor,
						sensitiveTablePatterns,
						enforceTenantIsolation: options.enforceTenantIsolation ?? false,
						approvalHandler: options.approvalHandler,
						safetyLevel,
						auditContext: options.auditContext,
					},
					sql,
					context,
				),
		}),
		qcp_suggest_query_improvements: createTool({
			id: "qcp_suggest_query_improvements",
			description:
				"Analyze a read-only PostgreSQL query plan and schema metadata to suggest advisory performance improvements such as missing indexes and SELECT * warnings. Suggested DDL is never executed.",
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
					analysis: queryPerformanceAnalysisSchema,
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
					privacyPolicy: options.privacyPolicy,
					sensitiveTablePatterns,
					explainExecutor,
					safetyLevel,
					enforceTenantIsolation: options.enforceTenantIsolation ?? false,
					requestContext: context?.requestContext,
					toolKind: "performance",
				}),
			toModelOutput: sanitizedToolModelOutput,
			transform: secureToolTransform(),
			mcp: {
				annotations: {
					title: "Suggest Query Improvements",
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: false,
				},
			},
			execute: async ({ sql }, context) =>
				executeSecureQueryImprovementAnalysis(
					{
						databaseUrl: options.databaseUrl,
						schema: options.schema,
						privacyPolicy: options.privacyPolicy,
						explainExecutor,
						sensitiveTablePatterns,
						enforceTenantIsolation: options.enforceTenantIsolation ?? false,
						approvalHandler: options.approvalHandler,
						safetyLevel,
						auditContext: options.auditContext,
					},
					sql,
					context,
				),
		}),
		qcp_export_database_data: createTool({
			id: "qcp_export_database_data",
			description:
				"Export selected database table data or a validated read-only SQL query result to a local file. Use this when the user asks to export, download, save, or dump data.",
			strict: true,
			inputSchema: z
				.object({
					filePath: z.string().min(1),
					format: transferFormatSchema.optional(),
					sql: z.string().min(1).optional(),
					table: z
						.object({
							schema: z.string().min(1).optional(),
							table: z.string().min(1),
						})
						.optional(),
				})
				.refine((value) => Boolean(value.sql ?? value.table), {
					message: "Export requires either sql or table.",
				}),
			outputSchema: transferResultSchema,
			requireApproval: async () =>
				requiresSafetyApproval({
					safetyLevel,
					toolKind: "export",
				}),
			toModelOutput: sanitizedToolModelOutput,
			transform: secureToolTransform(),
			mcp: {
				annotations: {
					title: "Export Database Data",
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: false,
					openWorldHint: false,
				},
			},
			execute: async (input) => {
				const request = input as TransferExportRequest;
				const approved = await confirmTransferApproval({
					approvalHandler: options.approvalHandler,
					safetyLevel,
					toolKind: "export",
					reasons: [],
					operation: formatExportOperation(request),
				});
				if (!approved) {
					return {
						ok: false,
						direction: "export",
						format: request.format,
						filePath: request.filePath,
						error: "Export requires approval before writing database data.",
					} satisfies TransferResult;
				}
				return transferService.exportData(request);
			},
		}),
		qcp_import_database_data: createTool({
			id: "qcp_import_database_data",
			description:
				"Import local data into the active database by creating a new table only. Never append to, replace, truncate, or modify an existing table.",
			strict: true,
			inputSchema: z.object({
				filePath: z.string().min(1),
				format: transferFormatSchema.optional(),
				tableName: z.string().min(1).optional(),
				schemaName: z.string().min(1).optional(),
			}),
			outputSchema: transferResultSchema,
			requireApproval: async () => true,
			toModelOutput: sanitizedToolModelOutput,
			transform: secureToolTransform(),
			mcp: {
				annotations: {
					title: "Import Database Data",
					readOnlyHint: false,
					destructiveHint: false,
					idempotentHint: false,
					openWorldHint: false,
				},
			},
			execute: async (input) => {
				const request = input as TransferImportRequest;
				const approved = await confirmTransferApproval({
					approvalHandler: options.approvalHandler,
					safetyLevel,
					toolKind: "import",
					reasons: [
						{
							type: "large_scan",
							detail:
								"Import creates a new table in the active database and requires approval.",
						},
					],
					operation: `IMPORT ${request.filePath} INTO ${request.schemaName ?? "public"}.${request.tableName ?? "(filename-derived table)"}`,
				});
				if (!approved) {
					return {
						ok: false,
						direction: "import",
						format: request.format,
						filePath: request.filePath,
						error: "Import requires approval before creating a table.",
					} satisfies TransferResult;
				}
				return transferService.importData(request);
			},
		}),
	};
}

export interface SecureReadOptions {
	readonly databaseUrl: string;
	readonly schema: DatabaseSchema;
	readonly privacyPolicy?: PostgresPrivacyPolicy;
	readonly queryExecutor?: DatabaseQueryExecutor;
	readonly sensitiveTablePatterns?: readonly string[];
	readonly enforceTenantIsolation?: boolean;
	readonly approvalHandler?: DatabaseToolApprovalHandler;
	readonly safetyLevel?: SafetyLevel;
	readonly auditContext?: AuditContext;
}

export interface SecureExplainOptions {
	readonly databaseUrl: string;
	readonly schema: DatabaseSchema;
	readonly privacyPolicy?: PostgresPrivacyPolicy;
	readonly explainExecutor?: DatabaseExplainExecutor;
	readonly sensitiveTablePatterns?: readonly string[];
	readonly enforceTenantIsolation?: boolean;
	readonly approvalHandler?: DatabaseToolApprovalHandler;
	readonly safetyLevel?: SafetyLevel;
	readonly auditContext?: AuditContext;
}

export interface SecureQueryImprovementOptions extends SecureExplainOptions {}

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

export type SecureQueryImprovementOutput =
	| {
			readonly ok: true;
			readonly safety: ReturnType<typeof validateSql>;
			readonly isolation?: ReturnType<typeof enforceTenantIsolation>;
			readonly plan: string;
			readonly estimatedRows: number;
			readonly approvalReasons: ReturnType<typeof getApprovalReasons>;
			readonly analysis: QueryPerformanceAnalysis;
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
		options.privacyPolicy,
		context,
	);
	if (!base.ok) {
		await auditDatabaseAccess({
			context: options.auditContext,
			action: "QUERY_REJECTED",
			outcome: "rejected",
			sql,
			safety: base.safety,
			isolation: base.isolation,
			approvalReasons: base.approvalReasons,
			error: base.error,
		});
		return base;
	}

	const approved = await confirmApprovalIfNeeded({
		reasons: base.approvalReasons,
		sql: base.processedSql,
		approvalHandler: options.approvalHandler,
		auditContext: options.auditContext,
		action: "READ",
		toolKind: "read",
		safetyLevel: options.safetyLevel ?? "standard",
		safety: base.safety,
		isolation: base.isolation,
	});
	if (!approved) {
		await auditDatabaseAccess({
			context: options.auditContext,
			action: "APPROVAL_DENIED",
			outcome: "cancelled",
			sql: base.processedSql,
			safety: base.safety,
			isolation: base.isolation,
			approvalReasons: base.approvalReasons,
			error: "Query requires approval before execution.",
		});
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
		await auditDatabaseAccess({
			context: options.auditContext,
			action: "READ",
			outcome: "success",
			sql: base.processedSql,
			safety: base.safety,
			isolation: base.isolation,
			approvalReasons: base.approvalReasons,
			result,
		});
		return {
			ok: true,
			safety: base.safety,
			isolation: base.isolation,
			result: sanitizeSensitiveData(result),
			approvalReasons: base.approvalReasons,
		};
	} catch (err: unknown) {
		await auditDatabaseAccess({
			context: options.auditContext,
			action: "READ",
			outcome: "failure",
			sql: base.processedSql,
			safety: base.safety,
			isolation: base.isolation,
			approvalReasons: base.approvalReasons,
			error: sanitizeDatabaseError(err),
		});
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
		options.privacyPolicy,
		context,
	);
	if (!base.ok) {
		await auditDatabaseAccess({
			context: options.auditContext,
			action: "QUERY_REJECTED",
			outcome: "rejected",
			sql,
			safety: base.safety,
			isolation: base.isolation,
			approvalReasons: base.approvalReasons,
			error: base.error,
		});
		return base;
	}

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
		const approved = await confirmApprovalIfNeeded({
			reasons: approvalReasons,
			sql: base.processedSql,
			approvalHandler: options.approvalHandler,
			auditContext: options.auditContext,
			action: "EXPLAIN",
			toolKind: "explain",
			safetyLevel: options.safetyLevel ?? "standard",
			safety: base.safety,
			isolation: base.isolation,
		});
		if (!approved) {
			await auditDatabaseAccess({
				context: options.auditContext,
				action: "APPROVAL_DENIED",
				outcome: "cancelled",
				sql: base.processedSql,
				safety: base.safety,
				isolation: base.isolation,
				approvalReasons,
				error: "Query requires approval before EXPLAIN.",
			});
			return {
				ok: false,
				safety: base.safety,
				isolation: base.isolation,
				error: "Query requires approval before EXPLAIN.",
				approvalReasons,
			};
		}

		await auditDatabaseAccess({
			context: options.auditContext,
			action: "EXPLAIN",
			outcome: "success",
			sql: base.processedSql,
			safety: base.safety,
			isolation: base.isolation,
			approvalReasons,
			estimatedRows: explain.estimatedRows,
		});
		return {
			ok: true,
			safety: base.safety,
			isolation: base.isolation,
			plan: sanitizeSensitiveData(explain.plan),
			estimatedRows: explain.estimatedRows,
			approvalReasons,
		};
	} catch (err: unknown) {
		await auditDatabaseAccess({
			context: options.auditContext,
			action: "EXPLAIN",
			outcome: "failure",
			sql: base.processedSql,
			safety: base.safety,
			isolation: base.isolation,
			approvalReasons: base.approvalReasons,
			error: sanitizeDatabaseError(err),
		});
		return {
			ok: false,
			safety: base.safety,
			isolation: base.isolation,
			error: sanitizeDatabaseError(err),
			approvalReasons: base.approvalReasons,
		};
	}
}

export async function executeSecureQueryImprovementAnalysis(
	options: SecureQueryImprovementOptions,
	sql: string,
	context?: unknown,
): Promise<SecureQueryImprovementOutput> {
	const base = prepareSecureQuery(
		sql,
		options.schema,
		options.sensitiveTablePatterns ?? [],
		options.enforceTenantIsolation ?? false,
		options.privacyPolicy,
		context,
	);
	if (!base.ok) {
		await auditDatabaseAccess({
			context: options.auditContext,
			action: "QUERY_REJECTED",
			outcome: "rejected",
			sql,
			safety: base.safety,
			isolation: base.isolation,
			approvalReasons: base.approvalReasons,
			error: base.error,
		});
		return base;
	}

	const sensitiveApproved = await confirmApprovalIfNeeded({
		reasons: base.approvalReasons,
		sql: base.processedSql,
		approvalHandler: options.approvalHandler,
		auditContext: options.auditContext,
		action: "EXPLAIN",
		toolKind: "performance",
		safetyLevel: options.safetyLevel ?? "standard",
		safety: base.safety,
		isolation: base.isolation,
	});
	if (!sensitiveApproved) {
		await auditDatabaseAccess({
			context: options.auditContext,
			action: "APPROVAL_DENIED",
			outcome: "cancelled",
			sql: base.processedSql,
			safety: base.safety,
			isolation: base.isolation,
			approvalReasons: base.approvalReasons,
			error: "Query requires approval before performance analysis.",
		});
		return {
			ok: false,
			safety: base.safety,
			isolation: base.isolation,
			error: "Query requires approval before performance analysis.",
			approvalReasons: base.approvalReasons,
		};
	}

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
		const newApprovalReasons = approvalReasons.filter(
			(reason) =>
				!base.approvalReasons.some(
					(baseReason) =>
						baseReason.type === reason.type &&
						baseReason.detail === reason.detail,
				),
		);
		const costApproved = await confirmApprovalIfNeeded({
			reasons: newApprovalReasons,
			sql: base.processedSql,
			approvalHandler: options.approvalHandler,
			auditContext: options.auditContext,
			action: "EXPLAIN",
			toolKind: "performance",
			safetyLevel:
				options.safetyLevel === "strict"
					? "low"
					: (options.safetyLevel ?? "standard"),
			safety: base.safety,
			isolation: base.isolation,
		});
		if (!costApproved) {
			await auditDatabaseAccess({
				context: options.auditContext,
				action: "APPROVAL_DENIED",
				outcome: "cancelled",
				sql: base.processedSql,
				safety: base.safety,
				isolation: base.isolation,
				approvalReasons,
				error: "Query requires approval before performance analysis.",
			});
			return {
				ok: false,
				safety: base.safety,
				isolation: base.isolation,
				error: "Query requires approval before performance analysis.",
				approvalReasons,
			};
		}

		const analysis = new QueryPerformanceAnalyzer(options.schema).analyze(
			base.processedSql,
			explain.plan,
		);

		await auditDatabaseAccess({
			context: options.auditContext,
			action: "EXPLAIN",
			outcome: "success",
			sql: base.processedSql,
			safety: base.safety,
			isolation: base.isolation,
			approvalReasons,
			estimatedRows: explain.estimatedRows,
			metadata: {
				analysis: {
					findingCount: analysis.findings.length,
					suggestedIndexCount: analysis.suggestedIndexes.length,
					warningCount: analysis.warnings.length,
				},
			},
		});
		return {
			ok: true,
			safety: base.safety,
			isolation: base.isolation,
			plan: sanitizeSensitiveData(explain.plan),
			estimatedRows: explain.estimatedRows,
			approvalReasons,
			analysis: sanitizeSensitiveData(analysis),
		};
	} catch (err: unknown) {
		await auditDatabaseAccess({
			context: options.auditContext,
			action: "EXPLAIN",
			outcome: "failure",
			sql: base.processedSql,
			safety: base.safety,
			isolation: base.isolation,
			approvalReasons: base.approvalReasons,
			error: sanitizeDatabaseError(err),
		});
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
	privacyPolicy?: PostgresPrivacyPolicy,
	context?: unknown,
): SecureBaseResult {
	const safety = applyPrivacyEvaluation(
		validateSql(sql),
		evaluatePostgresPrivacyPolicy({ sql, schema, policy: privacyPolicy }),
	);
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
	readonly privacyPolicy?: PostgresPrivacyPolicy;
	readonly sensitiveTablePatterns: readonly string[];
	readonly explainExecutor: DatabaseExplainExecutor;
	readonly safetyLevel: SafetyLevel;
	readonly toolKind: DatabaseSafetyToolKind;
	readonly enforceTenantIsolation: boolean;
	readonly requestContext?: unknown;
}

async function shouldRequireDatabaseToolApproval(
	options: ApprovalCheckOptions,
): Promise<boolean> {
	const safety = applyPrivacyEvaluation(
		validateSql(options.sql),
		evaluatePostgresPrivacyPolicy({
			sql: options.sql,
			schema: options.schema,
			policy: options.privacyPolicy,
		}),
	);
	if (!safety.safe) return false;

	const processedSql = options.enforceTenantIsolation
		? getTenantScopedSql(options.sql, options.schema, options.requestContext)
		: safety.processedSql;
	if (!processedSql) return false;

	if (
		requiresSafetyApproval({
			safetyLevel: options.safetyLevel,
			toolKind: options.toolKind,
			approvalReasons: getApprovalReasons(processedSql, safety, [
				...options.sensitiveTablePatterns,
			]),
		})
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
		return requiresSafetyApproval({
			safetyLevel: options.safetyLevel,
			toolKind: options.toolKind,
			approvalReasons: reasons,
		});
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

function formatExportOperation(request: TransferExportRequest): string {
	if (request.sql) return `EXPORT QUERY TO ${request.filePath}`;
	if (request.table) {
		return `EXPORT TABLE ${request.table.schema ?? "public"}.${request.table.table} TO ${request.filePath}`;
	}
	return `EXPORT DATABASE DATA TO ${request.filePath}`;
}

interface ApprovalConfirmationOptions {
	readonly reasons: readonly ApprovalReason[];
	readonly sql: string;
	readonly approvalHandler?: DatabaseToolApprovalHandler;
	readonly auditContext?: AuditContext;
	readonly action: "READ" | "EXPLAIN";
	readonly toolKind: DatabaseSafetyToolKind;
	readonly safetyLevel: SafetyLevel;
	readonly safety: ReturnType<typeof validateSql>;
	readonly isolation?: ReturnType<typeof enforceTenantIsolation>;
}

async function confirmApprovalIfNeeded(
	options: ApprovalConfirmationOptions,
): Promise<boolean> {
	if (
		!requiresSafetyApproval({
			safetyLevel: options.safetyLevel,
			toolKind: options.toolKind,
			approvalReasons: options.reasons,
		})
	) {
		return true;
	}
	const approvalReasons = approvalReasonsForSafetyLevel({
		safetyLevel: options.safetyLevel,
		toolKind: options.toolKind,
		approvalReasons: options.reasons,
	});

	await auditDatabaseAccess({
		context: options.auditContext,
		action: "APPROVAL_REQUIRED",
		outcome: "success",
		sql: options.sql,
		safety: options.safety,
		isolation: options.isolation,
		approvalReasons,
		metadata: { requestedAction: options.action },
	});

	if (!options.approvalHandler) return false;

	const approved = await options.approvalHandler(approvalReasons, options.sql);
	await auditDatabaseAccess({
		context: options.auditContext,
		action: approved ? "APPROVAL_GRANTED" : "APPROVAL_DENIED",
		outcome: approved ? "success" : "cancelled",
		sql: options.sql,
		safety: options.safety,
		isolation: options.isolation,
		approvalReasons,
		metadata: { requestedAction: options.action },
	});

	return approved;
}

async function confirmTransferApproval(options: {
	readonly approvalHandler?: DatabaseToolApprovalHandler;
	readonly safetyLevel: SafetyLevel;
	readonly toolKind: Extract<DatabaseSafetyToolKind, "export" | "import">;
	readonly reasons: readonly ApprovalReason[];
	readonly operation: string;
}): Promise<boolean> {
	if (
		!requiresSafetyApproval({
			safetyLevel: options.safetyLevel,
			toolKind: options.toolKind,
			approvalReasons: options.reasons,
		})
	) {
		return true;
	}
	if (!options.approvalHandler) return false;
	return options.approvalHandler(
		approvalReasonsForSafetyLevel({
			safetyLevel: options.safetyLevel,
			toolKind: options.toolKind,
			approvalReasons: options.reasons,
		}),
		options.operation,
	);
}

interface AuditDatabaseAccessOptions {
	readonly context?: AuditContext;
	readonly action: AuditAction;
	readonly outcome: AuditOutcome;
	readonly sql: string;
	readonly safety: ReturnType<typeof validateSql>;
	readonly isolation?: ReturnType<typeof enforceTenantIsolation>;
	readonly approvalReasons: readonly ApprovalReason[];
	readonly result?: QueryResult;
	readonly estimatedRows?: number;
	readonly error?: string;
	readonly metadata?: JsonValue;
}

async function auditDatabaseAccess(
	options: AuditDatabaseAccessOptions,
): Promise<void> {
	if (!options.context) return;

	const metadata = {
		safety: {
			safe: options.safety.safe,
			readOnly: options.safety.readOnly,
			allowedStatement: options.safety.allowedStatement,
			limitApplied: options.safety.limitApplied,
			errors: options.safety.errors,
			warnings: options.safety.warnings,
		},
		isolation: options.isolation
			? {
					safe: options.isolation.safe,
					errors: options.isolation.errors,
					warnings: options.isolation.warnings,
					injectedPredicates: options.isolation.injectedPredicates,
					scopedTables: options.isolation.scopedTables,
				}
			: null,
		approvalReasons: options.approvalReasons.map((reason) => ({
			type: reason.type,
			detail: reason.detail,
		})),
		result: options.result
			? {
					rowCount: options.result.rowCount,
					fields: options.result.fields,
					executionTimeMs: options.result.executionTimeMs,
				}
			: null,
		estimatedRows: options.estimatedRows ?? null,
		error: options.error ?? null,
		extra: options.metadata ?? null,
	} satisfies JsonValue;

	await writeAuditEvent(
		{
			scope: "data_access",
			action: options.action,
			actor: resolveAuditActor(options.context.installId),
			resource: {
				...buildAuditResource(options.context),
				statementType: options.safety.statementType,
				tables: extractSqlTables(options.sql),
				sql: sanitizeSensitiveData(options.sql),
			},
			delta: null,
			outcome: options.outcome,
			metadata,
		},
		{ logsDir: options.context.logsDir },
	);
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
