import { describe, expect, test } from "bun:test";
import {
	createDefaultConfig,
	getDatabaseUrl,
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
		expect(config.prismaSchemaPath).toBeUndefined();
		expect(config.prismaDatasourceName).toBeUndefined();
	});

	test("parses Prisma schema configuration", () => {
		const config = parseQcpConfig({
			databaseType: "prisma-postgres",
			prismaSchemaPath: "prisma/schema.prisma",
			prismaDatasourceName: "db",
		});

		expect(config.prismaSchemaPath).toBe("prisma/schema.prisma");
		expect(config.prismaDatasourceName).toBe("db");
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

	test("prefers PRISMA_DATABASE_URL for Prisma Postgres", () => {
		const originalPrisma = process.env.PRISMA_DATABASE_URL;
		const originalDatabase = process.env.DATABASE_URL;
		const originalQcp = process.env.QCP_DATABASE_URL;

		process.env.PRISMA_DATABASE_URL =
			"postgres://prisma_user:pass@db.prisma.io/app";
		process.env.DATABASE_URL = "postgres://database-url/app";
		process.env.QCP_DATABASE_URL = "postgres://qcp-database-url/app";

		try {
			const config = parseQcpConfig({
				databaseType: "prisma-postgres",
				databaseUrl: "postgres://configured/app",
			});

			expect(getDatabaseUrl(config)).toBe(process.env.PRISMA_DATABASE_URL);
		} finally {
			restoreEnv("PRISMA_DATABASE_URL", originalPrisma);
			restoreEnv("DATABASE_URL", originalDatabase);
			restoreEnv("QCP_DATABASE_URL", originalQcp);
		}
	});

	test("keeps configured URL precedence for non-Prisma databases", () => {
		const originalPrisma = process.env.PRISMA_DATABASE_URL;
		process.env.PRISMA_DATABASE_URL =
			"postgres://prisma_user:pass@db.prisma.io/app";

		try {
			const config = parseQcpConfig({
				databaseType: "other-postgres",
				databaseUrl: "postgres://configured/app",
			});

			expect(getDatabaseUrl(config)).toBe("postgres://configured/app");
		} finally {
			restoreEnv("PRISMA_DATABASE_URL", originalPrisma);
		}
	});
});

describe("database type inference", () => {
	test("infers Prisma Postgres URLs", () => {
		expect(inferDatabaseType("postgres://user:pass@db.prisma.io/app")).toBe(
			"prisma-postgres",
		);
	});

	test("infers Neon URLs", () => {
		expect(
			inferDatabaseType("postgres://user:pass@ep-blue.neon.tech/app"),
		).toBe("neon");
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

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		return;
	}

	process.env[key] = value;
}
