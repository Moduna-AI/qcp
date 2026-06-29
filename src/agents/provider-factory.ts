import type { ToolsInput } from "@mastra/core/agent";
import type { DatabaseSchema, QcpConfig } from "@/types/index.js";
import type { AbstractDatabaseAgent } from "./database-agent.js";
import {
	createDatabaseTools,
	type DatabaseToolApprovalHandler,
} from "./database-tools.js";
import { createMastraModelConfig } from "./model-config.js";
import { NeonAgent } from "./neon-agent.js";
import { OraclePostgresAgent } from "./oracle-postgres-agent.js";
import { PostgresAgent } from "./postgres-agent.js";
import { PrismaAgent } from "./prisma-agent.js";
import { SupabaseAgent } from "./supabase-agent.js";

export interface CreateProviderDatabaseAgentOptions {
	readonly config: QcpConfig;
	readonly databaseUrl: string;
	readonly schema: DatabaseSchema;
	readonly approvalHandler?: DatabaseToolApprovalHandler;
	readonly tools?: ToolsInput;
}

export type ProviderDatabaseAgent =
	| PostgresAgent<"qcp-postgres-agent">
	| PrismaAgent<"qcp-prisma-agent">
	| NeonAgent<"qcp-neon-agent">
	| SupabaseAgent<"qcp-supabase-agent">
	| OraclePostgresAgent<"qcp-oracle-postgres-agent">;

export function createProviderDatabaseAgent(
	options: CreateProviderDatabaseAgentOptions,
): ProviderDatabaseAgent {
	const model = createMastraModelConfig(options.config);
	const tools = {
		...createDatabaseTools({
			databaseUrl: options.databaseUrl,
			schema: options.schema,
			sensitiveTablePatterns: options.config.sensitiveTablePatterns,
			approvalHandler: options.approvalHandler,
		}),
		...(options.tools ?? {}),
	};

	switch (options.config.databaseType) {
		case "prisma-postgres":
			return new PrismaAgent({
				id: "qcp-prisma-agent",
				name: "QCP Prisma Database Agent",
				description:
					"Answers questions about Prisma Postgres databases using Prisma and qcp read-only database tools.",
				model,
				databaseUrl: options.databaseUrl,
				schema: options.schema,
				sensitiveTablePatterns: options.config.sensitiveTablePatterns,
				tools,
			});
		case "neon":
			return new NeonAgent({
				id: "qcp-neon-agent",
				name: "QCP Neon Database Agent",
				description:
					"Answers questions about Neon-hosted PostgreSQL databases using qcp read-only database tools.",
				model,
				tools,
			});
		case "supabase":
			return new SupabaseAgent({
				id: "qcp-supabase-agent",
				name: "QCP Supabase Database Agent",
				description:
					"Answers questions about Supabase-hosted PostgreSQL databases using qcp read-only database tools.",
				model,
				tools,
			});
		case "oracle-postgres":
			return new OraclePostgresAgent({
				id: "qcp-oracle-postgres-agent",
				name: "QCP Oracle PostgreSQL Agent",
				description:
					"Answers questions about PostgreSQL-compatible Oracle-hosted databases using qcp read-only database tools.",
				model,
				tools,
			});
		case "other-postgres":
			return new PostgresAgent({
				id: "qcp-postgres-agent",
				name: "QCP PostgreSQL Database Agent",
				description:
					"Answers questions about PostgreSQL databases using qcp read-only database tools.",
				model,
				tools,
			});
		default: {
			const _exhaustive: never = options.config.databaseType;
			return _exhaustive;
		}
	}
}

export function isProviderDatabaseAgent(
	agent: AbstractDatabaseAgent,
): agent is ProviderDatabaseAgent {
	return ["postgres", "prisma", "neon", "supabase", "oracle-postgres"].includes(
		agent.getDatabaseType(),
	);
}
