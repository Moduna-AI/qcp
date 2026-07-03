import { randomUUID } from "node:crypto";
import type { ToolsInput } from "@mastra/core/agent";
import type { ToolAction } from "@mastra/core/tools";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { AuditContext } from "@/logger/audit.js";
import { importPackageFromStore } from "@/packages/lazy-packages.js";
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

const neonDocsToolAllowlist = new Set([
	"list_docs_resources",
	"get_doc_resource",
]);

const neonContextSchema = z.object({
	databaseName: z.string(),
	tableCount: z.number(),
	schemaContext: z.string(),
	host: z.string().optional(),
	endpointId: z.string().optional(),
	regionHint: z.string().optional(),
	pooledConnection: z.boolean().optional(),
	sslMode: z.string().optional(),
	connectionGuidance: z.string(),
	mcpGuidance: z.string(),
	mcpDocs: z.object({
		enabled: z.boolean(),
		status: z.enum(["disabled", "available", "unavailable"]),
		allowedTools: z.array(z.string()),
		errors: z.record(z.string(), z.string()),
	}),
});

export interface NeonAgentConfig<TAgentId extends string = string>
	extends PostgresAgentConfig<TAgentId> {
	readonly databaseUrl?: string;
	readonly schema?: DatabaseSchema;
	readonly projectId?: string;
	readonly branchName?: string;
	readonly pooledConnection?: boolean;
	readonly sensitiveTablePatterns?: readonly string[];
	readonly queryExecutor?: DatabaseQueryExecutor;
	readonly explainExecutor?: DatabaseExplainExecutor;
	readonly approvalHandler?: DatabaseToolApprovalHandler;
	readonly auditContext?: AuditContext;
	readonly mcpDocsLoader?: NeonMcpDocsLoader;
}

export class NeonAgent<
	TAgentId extends string = string,
> extends PostgresAgent<TAgentId> {
	protected readonly neonConfig: NeonAgentConfig<TAgentId>;

	public constructor(config: NeonAgentConfig<TAgentId>) {
		super({
			...config,
			tools: {
				...(config.tools ?? {}),
				...(config.databaseUrl && config.schema
					? createNeonTools({
							databaseUrl: config.databaseUrl,
							schema: config.schema,
							sensitiveTablePatterns: config.sensitiveTablePatterns,
							queryExecutor: config.queryExecutor,
							explainExecutor: config.explainExecutor,
							approvalHandler: config.approvalHandler,
							auditContext: config.auditContext,
							mcpDocsLoader: config.mcpDocsLoader,
						})
					: {}),
			},
		});
		this.neonConfig = config;
	}

	public override getDatabaseType(): DatabaseAgentType {
		return "neon";
	}

	protected override getPostgresProviderInstructions(): string[] {
		return [
			"Treat the database as a Neon-hosted PostgreSQL database.",
			"Account for Neon concepts such as projects, branches, pooled connections, and serverless connection behavior when relevant.",
			"Prefer short-lived, efficient queries because serverless PostgreSQL connections may be pooled or cold-started.",
			"Use qcp_read_neon_context before answering Neon-specific connection, pooling, branching, endpoint, or managed Postgres questions.",
			"When a pooled Neon connection is detected, avoid session-dependent SQL such as SET search_path and prefer explicit schema-qualified table references.",
			"Use only qcp read-only database tools for runtime database access. Neon MCP is docs/context-only in qcp and must not be used for SQL execution, migrations, branch mutations, auth provisioning, or project administration.",
			...this.getNeonContextInstructions(),
		];
	}

	protected getNeonContextInstructions(): string[] {
		return [
			this.neonConfig.projectId
				? `Neon project id: ${this.neonConfig.projectId}.`
				: "",
			this.neonConfig.branchName
				? `Neon branch name: ${this.neonConfig.branchName}.`
				: "",
			typeof this.neonConfig.pooledConnection === "boolean"
				? `Neon pooled connection enabled: ${this.neonConfig.pooledConnection}.`
				: "",
		].filter((instruction) => instruction.length > 0);
	}
}

export interface CreateNeonToolsOptions {
	readonly databaseUrl: string;
	readonly schema: DatabaseSchema;
	readonly sensitiveTablePatterns?: readonly string[];
	readonly queryExecutor?: DatabaseQueryExecutor;
	readonly explainExecutor?: DatabaseExplainExecutor;
	readonly approvalHandler?: DatabaseToolApprovalHandler;
	readonly auditContext?: AuditContext;
	readonly mcpDocsLoader?: NeonMcpDocsLoader;
}

export function createNeonTools(options: CreateNeonToolsOptions): ToolsInput {
	return {
		...createDatabaseTools({
			databaseUrl: options.databaseUrl,
			schema: options.schema,
			sensitiveTablePatterns: options.sensitiveTablePatterns,
			queryExecutor: options.queryExecutor,
			explainExecutor: options.explainExecutor,
			approvalHandler: options.approvalHandler,
			auditContext: options.auditContext,
		}),
		qcp_read_neon_context: createTool({
			id: "qcp_read_neon_context",
			description:
				"Read local qcp schema context plus inferred Neon endpoint, pooling, SSL, and docs-only MCP guidance.",
			inputSchema: z.object({}),
			outputSchema: neonContextSchema,
			mcp: {
				annotations: {
					title: "Read Neon Context",
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: false,
				},
			},
			execute: async () => {
				const connection = inferNeonConnection(options.databaseUrl);
				const mcpDocs = await (options.mcpDocsLoader ?? loadNeonMcpDocsContext)();

				return {
					databaseName: options.schema.databaseName,
					tableCount: options.schema.tableCount,
					schemaContext: formatSchemaForDatabaseAgent(options.schema),
					host: connection.host,
					endpointId: connection.endpointId,
					regionHint: connection.regionHint,
					pooledConnection: connection.pooledConnection,
					sslMode: connection.sslMode,
					connectionGuidance: buildNeonConnectionGuidance(connection),
					mcpGuidance:
						"Neon MCP is docs/context-only in qcp. Do not use Neon MCP for SQL execution, migrations, branch changes, auth provisioning, Data API provisioning, or project administration; use qcp read-only database tools instead.",
					mcpDocs: {
						...mcpDocs,
						allowedTools: [...mcpDocs.allowedTools],
					},
				};
			},
		}),
	};
}

export interface InferredNeonConnection {
	readonly host?: string;
	readonly endpointId?: string;
	readonly regionHint?: string;
	readonly pooledConnection?: boolean;
	readonly sslMode?: string;
}

export function inferNeonConnection(databaseUrl: string): InferredNeonConnection {
	try {
		const url = new URL(databaseUrl);
		const endpointMatch = /^(ep-[a-z0-9-]+?)(-pooler)?\.(.+\.neon\.tech)$/i.exec(
			url.hostname,
		);
		const endpointId = endpointMatch?.[1];
		const pooledConnection = endpointMatch
			? endpointMatch[2] === "-pooler"
			: undefined;
		const regionHint = endpointMatch?.[3]?.replace(/\.neon\.tech$/i, "");
		const sslMode = url.searchParams.get("sslmode") ?? undefined;

		return {
			host: url.hostname,
			endpointId,
			regionHint,
			pooledConnection,
			sslMode,
		};
	} catch {
		return {};
	}
}

function buildNeonConnectionGuidance(
	connection: InferredNeonConnection,
): string {
	const base =
		"Neon is managed Postgres. Keep queries bounded, read-only, and efficient for serverless compute.";
	if (connection.pooledConnection === true) {
		return `${base} This connection appears to use Neon pooling via PgBouncer transaction mode; avoid session-dependent statements such as SET search_path, temporary session state, SQL-level PREPARE, LISTEN/NOTIFY, and long-running analytics queries. Prefer explicit schema-qualified SQL.`;
	}
	if (connection.pooledConnection === false) {
		return `${base} This connection appears to be direct rather than pooled; direct connections are better for session-level features, but qcp still limits runtime access to validated read-only SQL.`;
	}

	return `${base} qcp could not determine whether this Neon URL is pooled, so avoid session-dependent SQL unless the user confirms a direct connection.`;
}

export interface NeonMcpDocsContext {
	readonly enabled: boolean;
	readonly status: "disabled" | "available" | "unavailable";
	readonly allowedTools: readonly string[];
	readonly errors: Record<string, string>;
}

export type NeonMcpDocsLoader = () => Promise<NeonMcpDocsContext>;

export interface NeonMcpDocsClient {
	listToolsWithErrors(): Promise<{
		readonly tools: Record<string, ToolAction<unknown, unknown, unknown, unknown>>;
		readonly errors: Record<string, string>;
	}>;
	disconnect(): Promise<void>;
}

export type NeonMcpDocsClientFactory = (
	apiKey: string,
) => Promise<NeonMcpDocsClient>;

export async function loadNeonMcpDocsContext(
	clientFactory: NeonMcpDocsClientFactory = createNeonMcpClient,
): Promise<NeonMcpDocsContext> {
	const apiKey = process.env.NEON_API_KEY;
	if (!apiKey) {
		return {
			enabled: false,
			status: "disabled",
			allowedTools: [],
			errors: {},
		};
	}

	let client: NeonMcpDocsClient | null = null;
	try {
		client = await clientFactory(apiKey);
		const { tools, errors } = await client.listToolsWithErrors();
		const allowedTools = Object.keys(tools)
			.map((toolName) => removeMcpServerPrefix(toolName))
			.filter((toolName) => neonDocsToolAllowlist.has(toolName))
			.sort((left, right) => left.localeCompare(right));

		return {
			enabled: true,
			status: allowedTools.length > 0 ? "available" : "unavailable",
			allowedTools,
			errors,
		};
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			enabled: true,
			status: "unavailable",
			allowedTools: [],
			errors: { neon: message },
		};
	} finally {
		await client?.disconnect().catch(() => {});
	}
}

async function createNeonMcpClient(
	apiKey: string,
): Promise<NeonMcpDocsClient> {
	const { MCPClient } = await importPackageFromStore<McpModule>("@mastra/mcp");
	return new MCPClient({
		id: `qcp-neon-${randomUUID()}`,
		servers: {
			neon: {
				url: new URL("https://mcp.neon.tech/mcp"),
				requestInit: {
					headers: {
						Authorization: `Bearer ${apiKey}`,
					},
				},
				forwardInstructions: false,
				requireToolApproval: ({ toolName }) =>
					!neonDocsToolAllowlist.has(removeMcpServerPrefix(toolName)),
			},
		},
		timeout: 15_000,
	});
}

interface McpModule {
	readonly MCPClient: new (config: {
		readonly id: string;
		readonly servers: Record<
			string,
			{
				readonly url: URL;
				readonly requestInit: {
					readonly headers: Record<string, string>;
				};
				readonly forwardInstructions: boolean;
				readonly requireToolApproval: (input: {
					readonly toolName: string;
				}) => boolean;
			}
		>;
		readonly timeout: number;
	}) => NeonMcpDocsClient;
}

function removeMcpServerPrefix(toolName: string): string {
	const dotIndex = toolName.indexOf(".");
	if (dotIndex >= 0) return toolName.slice(dotIndex + 1);

	const underscoreIndex = toolName.indexOf("_");
	if (underscoreIndex >= 0) {
		const maybeServerName = toolName.slice(0, underscoreIndex);
		if (maybeServerName === "neon") return toolName.slice(underscoreIndex + 1);
	}

	return toolName;
}
