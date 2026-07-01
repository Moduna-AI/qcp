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
