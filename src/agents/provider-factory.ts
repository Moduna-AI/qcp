import type { ToolsInput } from "@mastra/core/agent";
import type { AuditContext } from "@/logger/audit.js";
import type { DatabaseSchema, QcpConfig } from "@/types/index.js";
import type { AbstractDatabaseAgent } from "./database-agent.js";
import {
	createDatabaseTools,
	type DatabaseToolApprovalHandler,
} from "./database-tools.js";
import { createMastraModelConfig } from "./model-config.js";
import type { NeonAgent } from "./neon-agent.js";
import type { OraclePostgresAgent } from "./oracle-postgres-agent.js";
import type { PostgresAgent } from "./postgres-agent.js";
import type { PrismaAgent } from "./prisma-agent.js";
import type { SupabaseAgent } from "./supabase-agent.js";

export interface CreateProviderDatabaseAgentOptions {
	readonly config: QcpConfig;
	readonly databaseUrl: string;
	readonly schema: DatabaseSchema;
	readonly approvalHandler?: DatabaseToolApprovalHandler;
	readonly auditContext?: AuditContext;
	readonly tools?: ToolsInput;
}

export type ProviderDatabaseAgent =
	| PostgresAgent<"qcp-postgres-agent">
	| PrismaAgent<"qcp-prisma-agent">
	| NeonAgent<"qcp-neon-agent">
	| SupabaseAgent<"qcp-supabase-agent">
	| OraclePostgresAgent<"qcp-oracle-postgres-agent">;

export async function createProviderDatabaseAgent(
	options: CreateProviderDatabaseAgentOptions,
): Promise<ProviderDatabaseAgent> {
	const model = createMastraModelConfig(options.config);
	const tools = {
		...createDatabaseTools({
			databaseUrl: options.databaseUrl,
			schema: options.schema,
			sensitiveTablePatterns: options.config.sensitiveTablePatterns,
			approvalHandler: options.approvalHandler,
			auditContext: options.auditContext,
		}),
		...(options.tools ?? {}),
	};

	switch (options.config.databaseType) {
		case "prisma-postgres": {
			const { PrismaAgent } = await import("./prisma-agent.js");
			return new PrismaAgent({
				id: "qcp-prisma-agent",
				name: "QCP Prisma Database Agent",
				description:
					"Answers questions about Prisma Postgres databases using Prisma and qcp read-only database tools.",
				model,
				databaseUrl: options.databaseUrl,
				schema: options.schema,
				prismaSchemaPath: options.config.prismaSchemaPath,
				datasourceName: options.config.prismaDatasourceName,
				sensitiveTablePatterns: options.config.sensitiveTablePatterns,
				auditContext: options.auditContext,
				tools,
			});
		}
		case "neon": {
			const { NeonAgent } = await import("./neon-agent.js");
			return new NeonAgent({
				id: "qcp-neon-agent",
				name: "QCP Neon Database Agent",
				description:
					"Answers questions about Neon-hosted PostgreSQL databases using qcp read-only database tools.",
				model,
				tools,
			});
		}
		case "supabase": {
			const { SupabaseAgent } = await import("./supabase-agent.js");
			return new SupabaseAgent({
				id: "qcp-supabase-agent",
				name: "QCP Supabase Database Agent",
				description:
					"Answers questions about Supabase-hosted PostgreSQL databases using qcp read-only database tools.",
				model,
				databaseUrl: options.databaseUrl,
				schema: options.schema,
				sensitiveTablePatterns: options.config.sensitiveTablePatterns,
				approvalHandler: options.approvalHandler,
				auditContext: options.auditContext,
				tools,
			});
		}
		case "oracle-postgres": {
			const { OraclePostgresAgent } = await import(
				"./oracle-postgres-agent.js"
			);
			return new OraclePostgresAgent({
				id: "qcp-oracle-postgres-agent",
				name: "QCP Oracle PostgreSQL Agent",
				description:
					"Answers questions about PostgreSQL-compatible Oracle-hosted databases using qcp read-only database tools.",
				model,
				tools,
			});
		}
		case "other-postgres": {
			const { PostgresAgent } = await import("./postgres-agent.js");
			return new PostgresAgent({
				id: "qcp-postgres-agent",
				name: "QCP PostgreSQL Database Agent",
				description:
					"Answers questions about PostgreSQL databases using qcp read-only database tools.",
				model,
				tools,
			});
		}
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
