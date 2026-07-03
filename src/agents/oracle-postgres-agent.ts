import type { ToolsInput } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { AuditContext } from "@/logger/audit.js";
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

const oracleCloudRegionPattern = /(?:^|\.)([a-z]+(?:-[a-z]+)+-\d)(?:\.|$)/i;

const oraclePostgresContextSchema = z.object({
	databaseName: z.string(),
	tableCount: z.number(),
	schemaContext: z.string(),
	host: z.string().optional(),
	regionHint: z.string().optional(),
	serviceName: z.string().optional(),
	sslMode: z.string().optional(),
	connectionGuidance: z.string(),
	compatibilityGuidance: z.string(),
});

export interface OraclePostgresAgentConfig<TAgentId extends string = string>
	extends PostgresAgentConfig<TAgentId> {
	readonly databaseUrl?: string;
	readonly schema?: DatabaseSchema;
	readonly serviceName?: string;
	readonly region?: string;
	readonly sensitiveTablePatterns?: readonly string[];
	readonly queryExecutor?: DatabaseQueryExecutor;
	readonly explainExecutor?: DatabaseExplainExecutor;
	readonly approvalHandler?: DatabaseToolApprovalHandler;
	readonly auditContext?: AuditContext;
}

export class OraclePostgresAgent<
	TAgentId extends string = string,
> extends PostgresAgent<TAgentId> {
	protected readonly oraclePostgresConfig: OraclePostgresAgentConfig<TAgentId>;

	public constructor(config: OraclePostgresAgentConfig<TAgentId>) {
		super({
			...config,
			tools: {
				...(config.tools ?? {}),
				...(config.databaseUrl && config.schema
					? createOraclePostgresTools({
							databaseUrl: config.databaseUrl,
							schema: config.schema,
							serviceName: config.serviceName,
							region: config.region,
							sensitiveTablePatterns: config.sensitiveTablePatterns,
							queryExecutor: config.queryExecutor,
							explainExecutor: config.explainExecutor,
							approvalHandler: config.approvalHandler,
							auditContext: config.auditContext,
						})
					: {}),
			},
		});
		this.oraclePostgresConfig = config;
	}

	public override getDatabaseType(): DatabaseAgentType {
		return "oracle-postgres";
	}

	protected override getPostgresProviderInstructions(): string[] {
		return [
			"Treat the database as an Oracle PostgreSQL or OCI-hosted PostgreSQL-compatible database, not native Oracle Database.",
			"Use PostgreSQL syntax and qcp read-only database tools for runtime database access.",
			"Use qcp_read_oracle_postgres_context before answering Oracle PostgreSQL, OCI hosting, connection, compatibility, region, or service-name questions.",
			"Be explicit about Oracle PostgreSQL compatibility assumptions when PostgreSQL behavior may vary across managed database providers.",
			"Do not use or suggest native Oracle SQL dialect, OCI management APIs, IAM changes, migration operations, privileged administration, or any data-changing operation.",
			...this.getOraclePostgresContextInstructions(),
		];
	}

	protected getOraclePostgresContextInstructions(): string[] {
		return [
			this.oraclePostgresConfig.serviceName
				? `Oracle PostgreSQL service name: ${this.oraclePostgresConfig.serviceName}.`
				: "",
			this.oraclePostgresConfig.region
				? `Oracle PostgreSQL region: ${this.oraclePostgresConfig.region}.`
				: "",
		].filter((instruction) => instruction.length > 0);
	}
}

export interface CreateOraclePostgresToolsOptions {
	readonly databaseUrl: string;
	readonly schema: DatabaseSchema;
	readonly serviceName?: string;
	readonly region?: string;
	readonly sensitiveTablePatterns?: readonly string[];
	readonly queryExecutor?: DatabaseQueryExecutor;
	readonly explainExecutor?: DatabaseExplainExecutor;
	readonly approvalHandler?: DatabaseToolApprovalHandler;
	readonly auditContext?: AuditContext;
}

export function createOraclePostgresTools(
	options: CreateOraclePostgresToolsOptions,
): ToolsInput {
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
		qcp_read_oracle_postgres_context: createTool({
			id: "qcp_read_oracle_postgres_context",
			description:
				"Read local qcp schema context plus inferred Oracle PostgreSQL or OCI-hosted PostgreSQL connection, region, service, and compatibility guidance.",
			inputSchema: z.object({}),
			outputSchema: oraclePostgresContextSchema,
			mcp: {
				annotations: {
					title: "Read Oracle PostgreSQL Context",
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: false,
				},
			},
			execute: async () => {
				const connection = inferOraclePostgresConnection(options.databaseUrl);
				const serviceName = options.serviceName ?? connection.serviceName;
				const regionHint = options.region ?? connection.regionHint;

				return {
					databaseName: options.schema.databaseName,
					tableCount: options.schema.tableCount,
					schemaContext: formatSchemaForDatabaseAgent(options.schema),
					host: connection.host,
					regionHint,
					serviceName,
					sslMode: connection.sslMode,
					connectionGuidance: buildOraclePostgresConnectionGuidance({
						...connection,
						regionHint,
						serviceName,
					}),
					compatibilityGuidance:
						"Oracle PostgreSQL support in qcp uses PostgreSQL-compatible URLs, PostgreSQL syntax, and qcp read-only database tools. Native Oracle Database connection strings, PL/SQL, OCI administration, IAM, migrations, and write operations are outside this agent's runtime scope.",
				};
			},
		}),
	};
}

export interface InferredOraclePostgresConnection {
	readonly host?: string;
	readonly regionHint?: string;
	readonly serviceName?: string;
	readonly sslMode?: string;
}

export function inferOraclePostgresConnection(
	databaseUrl: string,
): InferredOraclePostgresConnection {
	try {
		const url = new URL(databaseUrl);
		const regionHint = inferOracleCloudRegion(url.hostname);
		const serviceName = inferServiceName(url);
		const sslMode = url.searchParams.get("sslmode") ?? undefined;

		return {
			host: url.hostname,
			regionHint,
			serviceName,
			sslMode,
		};
	} catch {
		return {};
	}
}

function inferOracleCloudRegion(hostname: string): string | undefined {
	const match = oracleCloudRegionPattern.exec(hostname.toLowerCase());
	return match?.[1];
}

function inferServiceName(url: URL): string | undefined {
	const pathname = decodeURIComponent(url.pathname).replace(/^\/+/, "");
	if (!pathname) return undefined;

	const [databaseName] = pathname.split("/");
	return databaseName || undefined;
}

function buildOraclePostgresConnectionGuidance(
	connection: InferredOraclePostgresConnection,
): string {
	const base =
		"Oracle PostgreSQL is treated as managed PostgreSQL in qcp. Keep queries bounded, read-only, and compatible with standard PostgreSQL.";
	const details = [
		connection.regionHint
			? `Inferred OCI region: ${connection.regionHint}.`
			: "",
		connection.serviceName
			? `Inferred PostgreSQL database or service name: ${connection.serviceName}.`
			: "",
		connection.sslMode ? `Connection sslmode: ${connection.sslMode}.` : "",
	].filter((detail) => detail.length > 0);

	return details.length > 0 ? `${base} ${details.join(" ")}` : base;
}
