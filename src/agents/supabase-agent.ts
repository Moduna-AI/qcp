import type { ToolsInput } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { DatabaseSchema } from "@/types/index.js";
import type { DatabaseAgentType } from "./database-agent.js";
import {
	createDatabaseTools,
	type DatabaseExplainExecutor,
	type DatabaseQueryExecutor,
	type DatabaseToolApprovalHandler,
	formatSchemaForDatabaseAgent,
} from "./database-tools.js";
import { PostgresAgent, type PostgresAgentConfig } from "./postgres-agent.js";

const supabaseSchemaNames = new Set([
	"public",
	"auth",
	"storage",
	"realtime",
	"graphql_public",
	"supabase_functions",
	"vault",
	"extensions",
]);

const supabaseContextSchema = z.object({
	databaseName: z.string(),
	tableCount: z.number(),
	schemaContext: z.string(),
	projectHost: z.string().optional(),
	projectRef: z.string().optional(),
	detectedSchemas: z.array(z.string()),
	supabaseSchemas: z.array(
		z.object({
			schema: z.string(),
			tables: z.array(z.string()),
		}),
	),
	rlsGuidance: z.string(),
	mcpGuidance: z.string(),
});

export interface SupabaseAgentConfig<TAgentId extends string = string>
	extends PostgresAgentConfig<TAgentId> {
	readonly databaseUrl?: string;
	readonly schema?: DatabaseSchema;
	readonly projectUrl?: string;
	readonly projectRef?: string;
	readonly useRowLevelSecurity?: boolean;
	readonly sensitiveTablePatterns?: readonly string[];
	readonly queryExecutor?: DatabaseQueryExecutor;
	readonly explainExecutor?: DatabaseExplainExecutor;
	readonly approvalHandler?: DatabaseToolApprovalHandler;
}

export class SupabaseAgent<
	TAgentId extends string = string,
> extends PostgresAgent<TAgentId> {
	protected readonly supabaseConfig: SupabaseAgentConfig<TAgentId>;

	public constructor(config: SupabaseAgentConfig<TAgentId>) {
		super({
			...config,
			tools: {
				...(config.tools ?? {}),
				...(config.databaseUrl && config.schema
					? createSupabaseTools({
							databaseUrl: config.databaseUrl,
							schema: config.schema,
							sensitiveTablePatterns: config.sensitiveTablePatterns,
							queryExecutor: config.queryExecutor,
							explainExecutor: config.explainExecutor,
							approvalHandler: config.approvalHandler,
						})
					: {}),
			},
		});
		this.supabaseConfig = config;
	}

	public override getDatabaseType(): DatabaseAgentType {
		return "supabase";
	}

	protected override getPostgresProviderInstructions(): string[] {
		return [
			"Treat the database as a Supabase-hosted PostgreSQL database.",
			"Use Supabase conventions when reasoning about the public schema, auth schema, storage schema, generated APIs, and Row Level Security (RLS).",
			"Use qcp_read_supabase_context before answering Supabase-specific schema, auth, storage, or RLS questions.",
			"When Supabase MCP is available outside qcp, prefer project-scoped, read-only MCP configuration with only the docs and database feature groups enabled. Use Supabase MCP search_docs for documentation lookups.",
			"Do not use or suggest Supabase Management API, auth admin, storage mutation, service-role mutation, or any data-changing operation.",
			"Do not bypass RLS assumptions. Mention when answers may differ between service-role or direct database access and end-user access through Supabase RLS policies.",
			...this.getSupabaseContextInstructions(),
		];
	}

	protected getSupabaseContextInstructions(): string[] {
		return [
			this.supabaseConfig.projectUrl
				? `Supabase project URL: ${this.supabaseConfig.projectUrl}.`
				: "",
			this.supabaseConfig.projectRef
				? `Supabase project ref: ${this.supabaseConfig.projectRef}.`
				: "",
			typeof this.supabaseConfig.useRowLevelSecurity === "boolean"
				? `Supabase row-level security expected: ${this.supabaseConfig.useRowLevelSecurity}.`
				: "",
		].filter((instruction) => instruction.length > 0);
	}
}

export interface CreateSupabaseToolsOptions {
	readonly databaseUrl: string;
	readonly schema: DatabaseSchema;
	readonly sensitiveTablePatterns?: readonly string[];
	readonly queryExecutor?: DatabaseQueryExecutor;
	readonly explainExecutor?: DatabaseExplainExecutor;
	readonly approvalHandler?: DatabaseToolApprovalHandler;
}

export function createSupabaseTools(
	options: CreateSupabaseToolsOptions,
): ToolsInput {
	return {
		...createDatabaseTools({
			databaseUrl: options.databaseUrl,
			schema: options.schema,
			sensitiveTablePatterns: options.sensitiveTablePatterns,
			queryExecutor: options.queryExecutor,
			explainExecutor: options.explainExecutor,
			approvalHandler: options.approvalHandler,
		}),
		qcp_read_supabase_context: createTool({
			id: "qcp_read_supabase_context",
			description:
				"Read local qcp schema context plus inferred Supabase project, schema, auth, storage, and RLS guidance.",
			inputSchema: z.object({}),
			outputSchema: supabaseContextSchema,
			mcp: {
				annotations: {
					title: "Read Supabase Context",
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: false,
				},
			},
			execute: async () => {
				const project = inferSupabaseProject(options.databaseUrl);
				const supabaseSchemas = getSupabaseSchemaTables(options.schema);

				return {
					databaseName: options.schema.databaseName,
					tableCount: options.schema.tableCount,
					schemaContext: formatSchemaForDatabaseAgent(options.schema),
					projectHost: project.projectHost,
					projectRef: project.projectRef,
					detectedSchemas: getDetectedSchemas(options.schema),
					supabaseSchemas,
					rlsGuidance:
						"Supabase Row Level Security policies can make direct database or service-role results differ from end-user API results. Keep answers read-only and call out that visibility may depend on the active role, JWT claims, and configured RLS policies.",
					mcpGuidance:
						"Supabase MCP is separate from qcp auth. If connected, configure it with project_ref, read_only=true, and the docs,database feature groups. Use search_docs for Supabase documentation and avoid write-capable MCP tools in qcp read-only flows.",
				};
			},
		}),
	};
}

interface InferredSupabaseProject {
	readonly projectHost?: string;
	readonly projectRef?: string;
}

function inferSupabaseProject(databaseUrl: string): InferredSupabaseProject {
	try {
		const url = new URL(databaseUrl);
		const projectRef =
			inferProjectRefFromHost(url.hostname) ??
			inferProjectRefFromUsername(url.username);

		return {
			projectHost: url.hostname,
			projectRef,
		};
	} catch {
		return {};
	}
}

function inferProjectRefFromHost(hostname: string): string | undefined {
	const normalized = hostname.toLowerCase();
	const directMatch = /^db\.([a-z0-9-]+)\.supabase\.co$/.exec(normalized);
	if (directMatch?.[1]) return directMatch[1];

	const apiMatch = /^([a-z0-9-]+)\.supabase\.co$/.exec(normalized);
	if (apiMatch?.[1] && apiMatch[1] !== "pooler") return apiMatch[1];

	return undefined;
}

function inferProjectRefFromUsername(username: string): string | undefined {
	const decoded = decodeURIComponent(username);
	const match = /^postgres\.([a-z0-9-]+)$/i.exec(decoded);
	return match?.[1];
}

function getDetectedSchemas(schema: DatabaseSchema): string[] {
	return [...new Set(schema.tables.map((table) => table.schema))].sort((a, b) =>
		a.localeCompare(b),
	);
}

function getSupabaseSchemaTables(
	schema: DatabaseSchema,
): Array<{ readonly schema: string; readonly tables: string[] }> {
	const bySchema = new Map<string, string[]>();

	for (const table of schema.tables) {
		if (!supabaseSchemaNames.has(table.schema)) continue;

		const tables = bySchema.get(table.schema) ?? [];
		tables.push(table.name);
		bySchema.set(table.schema, tables);
	}

	return [...bySchema.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([schemaName, tables]) => ({
			schema: schemaName,
			tables: [...tables].sort((left, right) => left.localeCompare(right)),
		}));
}
