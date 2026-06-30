import { describe, expect, test } from "bun:test";
import type { QcpConfig } from "@/types/index.js";
import { shouldUsePrismaAgent } from "./prisma-query.js";

describe("Prisma command routing", () => {
	test("uses Prisma agent only for Prisma Postgres", () => {
		expect(
			shouldUsePrismaAgent(configWithDatabaseType("prisma-postgres")),
		).toBe(true);
		expect(shouldUsePrismaAgent(configWithDatabaseType("neon"))).toBe(false);
		expect(shouldUsePrismaAgent(configWithDatabaseType("supabase"))).toBe(
			false,
		);
		expect(shouldUsePrismaAgent(configWithDatabaseType("other-postgres"))).toBe(
			false,
		);
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
