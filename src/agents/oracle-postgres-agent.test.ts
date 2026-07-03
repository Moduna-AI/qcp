import { describe, expect, test } from "bun:test";
import type { ToolsInput } from "@mastra/core/agent";
import type { ToolAction } from "@mastra/core/tools";
import type { DatabaseSchema, QcpConfig } from "@/types/index.js";
import { createMastraModelConfig } from "./model-config.js";
import {
	createOraclePostgresTools,
	inferOraclePostgresConnection,
	OraclePostgresAgent,
} from "./oracle-postgres-agent.js";

const schema: DatabaseSchema = {
	scannedAt: "2026-07-03T00:00:00.000Z",
	databaseName: "appdb",
	tableCount: 2,
	tables: [
		{
			schema: "public",
			name: "projects",
			columns: [],
			primaryKeys: [],
			foreignKeys: [],
			indexes: [],
		},
		{
			schema: "analytics",
			name: "events",
			columns: [],
			primaryKeys: [],
			foreignKeys: [],
			indexes: [],
		},
	],
};

describe("oracle postgres database agent", () => {
	test("reports the oracle postgres database type", () => {
		const agent = createAgent();

		expect(agent.getDatabaseType()).toBe("oracle-postgres");
	});

	test("includes Oracle PostgreSQL-specific read-only instructions", async () => {
		const agent = createAgent();
		const instructions = await agent.getAgent().getInstructions();
		const text = Array.isArray(instructions)
			? instructions.join("\n")
			: String(instructions);

		expect(text).toContain("Oracle PostgreSQL");
		expect(text).toContain("OCI-hosted PostgreSQL");
		expect(text).toContain("qcp_read_oracle_postgres_context");
		expect(text).toContain("PostgreSQL syntax");
		expect(text).toContain("qcp read-only database tools");
		expect(text).toContain("native Oracle SQL dialect");
		expect(text).toContain("OCI management APIs");
		expect(text).toContain("data-changing operation");
	});

	test("adds generic read-only tools plus Oracle PostgreSQL context", () => {
		const tools = createOraclePostgresTools({
			databaseUrl:
				"postgresql://reader:secret@postgres.us-ashburn-1.oraclecloud.com:5432/appdb?sslmode=require",
			schema,
		});

		expect(Object.keys(tools).sort()).toEqual([
			"qcp_execute_read_sql",
			"qcp_explain_read_sql",
			"qcp_read_database_context",
			"qcp_read_oracle_postgres_context",
			"qcp_suggest_query_improvements",
			"qcp_validate_sql",
		]);
	});

	test("infers safe Oracle PostgreSQL connection context without credentials", async () => {
		const tools = createOraclePostgresTools({
			databaseUrl:
				"postgresql://reader:secret@postgres.us-ashburn-1.oraclecloud.com:5432/appdb?sslmode=require",
			schema,
		});

		const context = (await executeTool(
			tools,
			"qcp_read_oracle_postgres_context",
			{},
		)) as OraclePostgresContextOutput;
		const serialized = JSON.stringify(context);

		expect(context.host).toBe("postgres.us-ashburn-1.oraclecloud.com");
		expect(context.regionHint).toBe("us-ashburn-1");
		expect(context.serviceName).toBe("appdb");
		expect(context.sslMode).toBe("require");
		expect(context.connectionGuidance).toContain("managed PostgreSQL");
		expect(context.compatibilityGuidance).toContain("Native Oracle Database");
		expect(serialized).not.toContain("secret");
		expect(serialized).not.toContain("reader");
	});

	test("explicit service and region override inferred URL context", async () => {
		const tools = createOraclePostgresTools({
			databaseUrl:
				"postgresql://reader:secret@postgres.us-ashburn-1.oraclecloud.com:5432/appdb?sslmode=require",
			schema,
			serviceName: "reporting",
			region: "eu-frankfurt-1",
		});

		const context = (await executeTool(
			tools,
			"qcp_read_oracle_postgres_context",
			{},
		)) as OraclePostgresContextOutput;

		expect(context.regionHint).toBe("eu-frankfurt-1");
		expect(context.serviceName).toBe("reporting");
	});

	test("malformed URLs degrade to schema-only context without throwing", async () => {
		const tools = createOraclePostgresTools({
			databaseUrl: "not a url",
			schema,
		});

		const context = (await executeTool(
			tools,
			"qcp_read_oracle_postgres_context",
			{},
		)) as OraclePostgresContextOutput;

		expect(context.databaseName).toBe("appdb");
		expect(context.tableCount).toBe(2);
		expect(context.host).toBeUndefined();
		expect(context.regionHint).toBeUndefined();
		expect(context.serviceName).toBeUndefined();
		expect(context.connectionGuidance).toContain("managed PostgreSQL");
	});

	test("parses Oracle PostgreSQL URLs directly", () => {
		expect(
			inferOraclePostgresConnection(
				"postgres://u:p@postgres.eu-frankfurt-1.oci.oraclecloud.com:5432/reporting?sslmode=verify-full",
			),
		).toEqual({
			host: "postgres.eu-frankfurt-1.oci.oraclecloud.com",
			regionHint: "eu-frankfurt-1",
			serviceName: "reporting",
			sslMode: "verify-full",
		});
	});
});

interface OraclePostgresContextOutput {
	readonly databaseName: string;
	readonly tableCount: number;
	readonly host?: string;
	readonly regionHint?: string;
	readonly serviceName?: string;
	readonly sslMode?: string;
	readonly connectionGuidance: string;
	readonly compatibilityGuidance: string;
}

function createAgent(): OraclePostgresAgent<"qcp-oracle-postgres-agent"> {
	const config = configWithDatabaseType("oracle-postgres");

	return new OraclePostgresAgent({
		id: "qcp-oracle-postgres-agent",
		name: "QCP Oracle PostgreSQL Agent",
		description:
			"Answers questions about PostgreSQL-compatible Oracle-hosted databases using qcp read-only database tools.",
		model: createMastraModelConfig(config),
		databaseUrl:
			"postgresql://reader:secret@postgres.us-ashburn-1.oraclecloud.com:5432/appdb?sslmode=require",
		schema,
	});
}

async function executeTool(
	tools: ToolsInput,
	name: string,
	input: unknown,
): Promise<unknown> {
	const tool = tools[name] as
		| ToolAction<unknown, unknown, unknown, unknown>
		| undefined;
	if (!tool?.execute) {
		throw new Error(`Tool not found: ${name}`);
	}

	return tool.execute(input, {} as never);
}

function configWithDatabaseType(
	databaseType: QcpConfig["databaseType"],
): QcpConfig {
	return {
		version: "0.1.0",
		installId: "019a0000-0000-7000-8000-000000000000",
		databaseConnections: [],
		databaseType,
		provider: "gemini",
		model: "gemini-2.5-flash",
		telemetry: true,
		safeMode: true,
		showSql: true,
		showMetrics: false,
		sensitiveTablePatterns: [],
		apiKeys: {},
	};
}
