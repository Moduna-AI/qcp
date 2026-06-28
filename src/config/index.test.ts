import { describe, expect, test } from "bun:test";
import {
	createDefaultConfig,
	inferDatabaseType,
	isDatabaseType,
	parseQcpConfig,
} from "./index.js";

describe("database type config", () => {
	test("defaults to other PostgreSQL", () => {
		const config = createDefaultConfig();

		expect(config.databaseType).toBe("other-postgres");
	});

	test("parses older configs without databaseType", () => {
		const config = parseQcpConfig({
			version: "0.1.0",
			installId: "019a0000-0000-7000-8000-000000000000",
			provider: "gemini",
			model: "gemini-2.5-flash",
			telemetry: true,
			safeMode: true,
			showSql: true,
			showMetrics: false,
			sensitiveTablePatterns: [],
			apiKeys: {},
		});

		expect(config.databaseType).toBe("other-postgres");
	});

	test("validates database type values", () => {
		expect(isDatabaseType("prisma-postgres")).toBe(true);
		expect(isDatabaseType("neon")).toBe(true);
		expect(isDatabaseType("supabase")).toBe(true);
		expect(isDatabaseType("oracle-postgres")).toBe(true);
		expect(isDatabaseType("other-postgres")).toBe(true);
		expect(isDatabaseType("mysql")).toBe(false);
	});

	test("rejects invalid database type in config", () => {
		expect(() =>
			parseQcpConfig({
				databaseType: "mysql",
			}),
		).toThrow();
	});
});

describe("database type inference", () => {
	test("infers Prisma Postgres URLs", () => {
		expect(inferDatabaseType("postgres://user:pass@db.prisma.io/app")).toBe(
			"prisma-postgres",
		);
	});

	test("infers Neon URLs", () => {
		expect(inferDatabaseType("postgres://user:pass@ep-blue.neon.tech/app")).toBe(
			"neon",
		);
	});

	test("infers Supabase URLs", () => {
		expect(
			inferDatabaseType(
				"postgres://user:pass@aws-0-us-east-1.pooler.supabase.com/app",
			),
		).toBe("supabase");
	});

	test("falls back for generic PostgreSQL URLs", () => {
		expect(inferDatabaseType("postgres://user:pass@localhost:5432/app")).toBe(
			"other-postgres",
		);
		expect(
			inferDatabaseType("postgres://user:pass@localhost:5432/app", "neon"),
		).toBe("neon");
	});
});
