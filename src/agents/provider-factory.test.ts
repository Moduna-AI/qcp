import { describe, expect, test } from "bun:test";
import type { DatabaseSchema, QcpConfig } from "@/types/index.js";
import { createProviderDatabaseAgent } from "./provider-factory.js";

const schema: DatabaseSchema = {
	scannedAt: "2026-06-29T00:00:00.000Z",
	databaseName: "test",
	tableCount: 0,
	tables: [],
};

describe("provider database agent factory", () => {
	test("selects the concrete provider agent for each configured database type", async () => {
		const cases = [
			["prisma-postgres", "prisma"],
			["neon", "neon"],
			["supabase", "supabase"],
			["oracle-postgres", "oracle-postgres"],
			["other-postgres", "postgres"],
		] as const;

		for (const [databaseType, expectedAgentType] of cases) {
			const agent = await createProviderDatabaseAgent({
				config: configWithDatabaseType(databaseType),
				databaseUrl: "postgres://example",
				schema,
			});

			expect(agent.getDatabaseType()).toBe(expectedAgentType);
			expect(agent.getTools()).toHaveProperty("qcp_suggest_query_improvements");
		}
	});

	test("passes Supabase runtime context into the provider agent", async () => {
		const agent = await createProviderDatabaseAgent({
			config: configWithDatabaseType("supabase"),
			databaseUrl:
				"postgresql://postgres:secret@db.abcdefghijklmnopqrst.supabase.co:5432/postgres",
			schema,
		});

		expect(agent.getTools()).toHaveProperty("qcp_read_supabase_context");
	});

	test("passes Neon runtime context into the provider agent", async () => {
		const agent = await createProviderDatabaseAgent({
			config: configWithDatabaseType("neon"),
			databaseUrl:
				"postgresql://reader:secret@ep-cool-darkness-123456.us-east-2.aws.neon.tech/neondb?sslmode=require",
			schema,
		});

		expect(agent.getTools()).toHaveProperty("qcp_read_neon_context");
	});

	test("passes Oracle PostgreSQL runtime context into the provider agent", async () => {
		const agent = await createProviderDatabaseAgent({
			config: configWithDatabaseType("oracle-postgres"),
			databaseUrl:
				"postgresql://reader:secret@postgres.us-ashburn-1.oraclecloud.com:5432/appdb?sslmode=require",
			schema,
		});

		expect(agent.getTools()).toHaveProperty("qcp_read_oracle_postgres_context");
	});
});

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
