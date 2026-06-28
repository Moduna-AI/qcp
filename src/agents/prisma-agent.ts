import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { ToolsetsInput, ToolsInput } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { MCPClient } from "@mastra/mcp";
import { z } from "zod";
import { getApiKey } from "@/config/index.js";
import { executeQuery, explainQuery } from "@/db/index.js";
import { extractSqlAndExplanation } from "@/llm/prompts.js";
import { validateSql } from "@/safety/index.js";
import type {
	DatabaseSchema,
	ProviderName,
	QcpConfig,
	QueryResult,
	SqlGenerationResult,
} from "@/types/index.js";
import type { DatabaseAgentType } from "./database-agent.js";
import { PostgresAgent, type PostgresAgentConfig } from "./postgres-agent.js";

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

const queryResultSchema = z.object({
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
	prismaSchema: z.string().optional(),
});

export type PrismaQueryExecutor = (
	databaseUrl: string,
	sql: string,
) => Promise<QueryResult>;

export type PrismaExplainExecutor = (
	databaseUrl: string,
	sql: string,
) => Promise<{ plan: string; estimatedRows: number }>;

export interface PrismaAgentConfig<TAgentId extends string = string>
	extends PostgresAgentConfig<TAgentId> {
	readonly databaseUrl?: string;
	readonly schema?: DatabaseSchema;
	readonly prismaSchemaPath?: string;
	readonly datasourceName?: string;
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
	readonly queryExecutor?: PrismaQueryExecutor;
	readonly explainExecutor?: PrismaExplainExecutor;
}

export function createPrismaTools(
	options: CreatePrismaToolsOptions,
): ToolsInput {
	const queryExecutor = options.queryExecutor ?? executeQuery;
	const explainExecutor = options.explainExecutor ?? explainQuery;

	return {
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
				"Execute a SQL query only after qcp AST validation succeeds. Rejected SQL is returned as a structured safety error.",
			inputSchema: z.object({
				sql: z.string().min(1),
			}),
			outputSchema: z.discriminatedUnion("ok", [
				z.object({
					ok: z.literal(true),
					safety: safetyReportSchema,
					result: queryResultSchema,
				}),
				z.object({
					ok: z.literal(false),
					safety: safetyReportSchema,
					error: z.string(),
				}),
			]),
			mcp: {
				annotations: {
					title: "Execute Read SQL",
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: false,
					openWorldHint: false,
				},
			},
			execute: async ({ sql }) => {
				const safety = validateSql(sql);
				if (!safety.safe) {
					return {
						ok: false as const,
						safety,
						error: safety.errors[0] ?? "SQL rejected by qcp safety policy.",
					};
				}

				const result = await queryExecutor(
					options.databaseUrl,
					safety.processedSql,
				);
				return { ok: true as const, safety, result };
			},
		}),
		qcp_explain_read_sql: createTool({
			id: "qcp_explain_read_sql",
			description:
				"Run EXPLAIN for a SQL query only after qcp AST validation succeeds.",
			inputSchema: z.object({
				sql: z.string().min(1),
			}),
			outputSchema: z.discriminatedUnion("ok", [
				z.object({
					ok: z.literal(true),
					safety: safetyReportSchema,
					plan: z.string(),
					estimatedRows: z.number(),
				}),
				z.object({
					ok: z.literal(false),
					safety: safetyReportSchema,
					error: z.string(),
				}),
			]),
			mcp: {
				annotations: {
					title: "Explain Read SQL",
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: false,
				},
			},
			execute: async ({ sql }) => {
				const safety = validateSql(sql);
				if (!safety.safe) {
					return {
						ok: false as const,
						safety,
						error: safety.errors[0] ?? "SQL rejected by qcp safety policy.",
					};
				}

				const explain = await explainExecutor(
					options.databaseUrl,
					safety.processedSql,
				);
				return {
					ok: true as const,
					safety,
					plan: explain.plan,
					estimatedRows: explain.estimatedRows,
				};
			},
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
					schemaContext: formatSchemaForPrismaAgent(options.schema),
					prismaSchemaPath: options.prismaSchemaPath,
					prismaSchema,
				};
			},
		}),
	};
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

USER QUESTION:
${options.question}

Generate a safe, read-only PostgreSQL query for this Prisma Postgres database.
`.trim();
}

function createMastraModelConfig(
	config: QcpConfig,
): PrismaAgentConfig["model"] {
	const apiKey = getApiKey(config);
	applyProviderEnv(config.provider, apiKey);

	switch (config.provider) {
		case "gemini":
			return `google/${config.model}` as PrismaAgentConfig["model"];
		case "openai":
			return `openai/${config.model}` as PrismaAgentConfig["model"];
		case "anthropic":
			return `anthropic/${config.model}` as PrismaAgentConfig["model"];
		case "ollama":
			if (config.ollamaHost) {
				process.env.OLLAMA_BASE_URL = config.ollamaHost;
			}
			return `ollama/${config.model}` as PrismaAgentConfig["model"];
		default: {
			const _exhaustive: never = config.provider;
			return _exhaustive;
		}
	}
}

function applyProviderEnv(
	provider: ProviderName,
	apiKey: string | undefined,
): void {
	if (!apiKey || provider === "ollama") return;

	if (provider === "gemini") {
		process.env.GOOGLE_GENERATIVE_AI_API_KEY = apiKey;
		process.env.GOOGLE_API_KEY = apiKey;
		return;
	}

	if (provider === "openai") {
		process.env.OPENAI_API_KEY = apiKey;
		return;
	}

	process.env.ANTHROPIC_API_KEY = apiKey;
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

function stringProcessEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === "string") {
			env[key] = value;
		}
	}
	return env;
}
