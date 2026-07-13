import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DatabaseAliasConflictError,
	DatabaseConnectionRegistry,
	InvalidDatabaseAliasError,
} from "./database-connection-registry.js";
import {
	createDefaultConfig,
	enforceOwnerOnlyPermissions,
	getActiveDatabaseConnection,
	getDatabaseUrl,
	inferDatabaseType,
	isDatabaseType,
	parseQcpConfig,
	redactConfig,
} from "./index.js";

describe("database type config", () => {
	test("defaults to other PostgreSQL", () => {
		const config = createDefaultConfig();
		expect(config.databaseType).toBe("other-postgres");
		expect(config.databaseConnections).toEqual([]);
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
		expect(config.databaseConnections).toEqual([]);
		expect(config.prismaSchemaPath).toBeUndefined();
		expect(config.prismaDatasourceName).toBeUndefined();
		expect(config.safetyLevel).toBe("standard");
	});
	test("migrates legacy disabled safe mode to low safety level", () => {
		const config = parseQcpConfig({ safeMode: false });
		expect(config.safetyLevel).toBe("low");
		expect(config.safeMode).toBe(false);
	});
	test("parses explicit safety levels", () => {
		const config = parseQcpConfig({ safetyLevel: "strict", safeMode: false });
		expect(config.safetyLevel).toBe("strict");
		expect(config.safeMode).toBe(true);
		expect(() => parseQcpConfig({ safetyLevel: "unsafe" })).toThrow();
	});
	test("migrates legacy database fields into a named connection", () => {
		const config = parseQcpConfig({
			databaseType: "prisma-postgres",
			databaseUrl: "postgres://configured/app",
			prismaSchemaPath: "prisma/schema.prisma",
			prismaDatasourceName: "db",
		});
		expect(config.databaseConnections).toHaveLength(1);
		expect(config.databaseConnections[0]?.name).toBe("default");
		expect(config.activeDatabaseId).toBe("default");
		expect(config.databaseConnections[0]?.databaseType).toBe("prisma-postgres");
		expect(getActiveDatabaseConnection(config)?.name).toBe("default");
		expect(config.prismaSchemaPath).toBe("prisma/schema.prisma");
		expect(config.prismaDatasourceName).toBe("db");
	});
	test("resolves active connection by alias", () => {
		const config = parseQcpConfig({
			databaseConnections: [
				connectionConfig("prod", "other-postgres", "postgres://prod/app"),
				connectionConfig("analytics", "neon", "postgres://analytics/app"),
			],
			activeDatabaseId: "analytics",
		});
		expect(getActiveDatabaseConnection(config)?.name).toBe("analytics");
		expect(getActiveDatabaseConnection(config, "prod")?.databaseUrl).toBe(
			"postgres://prod/app",
		);
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
		expect(() => parseQcpConfig({ databaseType: "mysql" })).toThrow();
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
			expect(
				getDatabaseUrl(
					parseQcpConfig({
						databaseType: "prisma-postgres",
						databaseUrl: "postgres://configured/app",
					}),
				),
			).toBe(process.env.PRISMA_DATABASE_URL);
		} finally {
			restoreEnv("PRISMA_DATABASE_URL", originalPrisma);
			restoreEnv("DATABASE_URL", originalDatabase);
			restoreEnv("QCP_DATABASE_URL", originalQcp);
		}
	});
	test("keeps configured URL precedence for non-Prisma databases", () => {
		const original = process.env.PRISMA_DATABASE_URL;
		process.env.PRISMA_DATABASE_URL =
			"postgres://prisma_user:pass@db.prisma.io/app";
		try {
			expect(
				getDatabaseUrl(
					parseQcpConfig({
						databaseType: "other-postgres",
						databaseUrl: "postgres://configured/app",
					}),
				),
			).toBe("postgres://configured/app");
		} finally {
			restoreEnv("PRISMA_DATABASE_URL", original);
		}
	});
	test("uses PRISMA_DATABASE_URL when no connection is configured", () => {
		const original = process.env.PRISMA_DATABASE_URL;
		process.env.PRISMA_DATABASE_URL =
			"postgres://prisma_user:pass@db.prisma.io/app";
		try {
			expect(
				getDatabaseUrl(parseQcpConfig({ databaseType: "prisma-postgres" })),
			).toBe(process.env.PRISMA_DATABASE_URL);
		} finally {
			restoreEnv("PRISMA_DATABASE_URL", original);
		}
	});
	test("redacts all configured database URLs", () => {
		const redacted = redactConfig(
			parseQcpConfig({
				databaseConnections: [
					connectionConfig("prod", "other-postgres", "postgres://prod/app"),
				],
				activeDatabaseId: "prod",
			}),
		);
		expect(redacted.databaseConnections).toEqual([
			expect.objectContaining({ name: "prod", databaseUrl: "[REDACTED]" }),
		]);
	});
});

describe("database connection registry", () => {
	test("normalizes aliases and upserts active connections", () => {
		const snapshot = new DatabaseConnectionRegistry(
			createDefaultConfig(),
		).upsert({
			name: "Prod",
			databaseType: "other-postgres",
			databaseUrl: "postgres://prod/app",
		});
		expect(snapshot.connections[0]?.name).toBe("prod");
		expect(snapshot.activeDatabaseId).toBe(snapshot.connections[0]?.id);
	});
	test("rejects invalid aliases", () => {
		expect(() =>
			new DatabaseConnectionRegistry(createDefaultConfig()).upsert({
				name: "bad alias",
				databaseType: "other-postgres",
				databaseUrl: "postgres://prod/app",
			}),
		).toThrow(InvalidDatabaseAliasError);
	});
	test("updates a connection while preserving id and createdAt", () => {
		const config = parseQcpConfig({
			databaseConnections: [
				{
					...connectionConfig("prod", "other-postgres", "postgres://prod/app"),
					createdAt: "2026-06-30T00:00:00.000Z",
				},
			],
			activeDatabaseId: "prod",
		});
		const updated = new DatabaseConnectionRegistry(config).update("prod", {
			name: "production",
			databaseType: "neon",
			databaseUrl: "postgres://production/app",
		}).connections[0];
		expect(updated?.id).toBe("prod");
		expect(updated?.name).toBe("production");
		expect(updated?.createdAt).toBe("2026-06-30T00:00:00.000Z");
		expect(updated?.databaseType).toBe("neon");
		expect(updated?.databaseUrl).toBe("postgres://production/app");
	});
	test("rejects renames that collide with another connection", () => {
		const config = parseQcpConfig({
			databaseConnections: [
				connectionConfig("prod", "other-postgres", "postgres://prod/app"),
				connectionConfig(
					"analytics",
					"other-postgres",
					"postgres://analytics/app",
				),
			],
		});
		expect(() =>
			new DatabaseConnectionRegistry(config).update("prod", {
				name: "analytics",
			}),
		).toThrow(DatabaseAliasConflictError);
	});
	test("clears Prisma metadata when changing to a non-Prisma database", () => {
		const config = parseQcpConfig({
			databaseConnections: [
				{
					...connectionConfig("prod", "prisma-postgres", "postgres://prod/app"),
					prismaSchemaPath: "prisma/schema.prisma",
					prismaDatasourceName: "db",
				},
			],
		});
		const updated = new DatabaseConnectionRegistry(config).update("prod", {
			databaseType: "neon",
		}).connections[0];
		expect(updated?.prismaSchemaPath).toBeUndefined();
		expect(updated?.prismaDatasourceName).toBeUndefined();
	});
	test("selects the next sorted connection after removing the active one", () => {
		const config = parseQcpConfig({
			databaseConnections: [
				connectionConfig("zeta", "other-postgres", "postgres://zeta/app"),
				connectionConfig("prod", "other-postgres", "postgres://prod/app"),
				connectionConfig("alpha", "other-postgres", "postgres://alpha/app"),
			],
			activeDatabaseId: "prod",
		});
		expect(
			new DatabaseConnectionRegistry(config).remove("prod").activeDatabaseId,
		).toBe("alpha");
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

describe("enforceOwnerOnlyPermissions", () => {
	test("restricts a credential file to its owner on POSIX", () => {
		const path = join(
			mkdtempSync(join(tmpdir(), "qcp-config-")),
			"config.json",
		);
		writeFileSync(path, "{}");
		expect(enforceOwnerOnlyPermissions(path, 0o600)).toBe(true);
		if (process.platform !== "win32")
			expect(statSync(path).mode & 0o777).toBe(0o600);
	});
});

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		return;
	}
	process.env[key] = value;
}
function connectionConfig(
	name: string,
	databaseType: ReturnType<typeof createDefaultConfig>["databaseType"],
	databaseUrl: string,
) {
	return {
		id: name,
		name,
		databaseType,
		databaseUrl,
		createdAt: "2026-06-30T00:00:00.000Z",
		updatedAt: "2026-06-30T00:00:00.000Z",
	};
}
