import { describe, expect, test } from "bun:test";
import type { QcpConfig } from "@/types/index.js";
import { buildConfigContext, redactDatabaseUrl } from "./config-tools.js";

describe("config audit tools", () => {
	test("builds redacted multi-connection config context", () => {
		const context = buildConfigContext({
			loadConfig: () => configWithConnections(),
			schemaCatalogHasConnection: (connectionId) => connectionId === "prod-id",
		});

		expect(context.config).toEqual({
			provider: "gemini",
			model: "gemini-2.5-flash",
			safeMode: true,
			showSql: true,
			showMetrics: false,
			telemetry: true,
		});
		expect(context.connections).toHaveLength(2);
		expect(context.activeConnection?.name).toBe("prod");
		expect(
			context.connections.find((item) => item.name === "prod"),
		).toMatchObject({
			active: true,
			schemaIndexed: true,
			url: {
				host: "db.example.com",
				database: "app",
				user: "readonly",
				password: "[REDACTED]",
			},
		});
		expect(
			context.connections.find((item) => item.name === "staging"),
		).toMatchObject({
			active: false,
			schemaIndexed: false,
		});
		expect(context.commands.switchConnection).toBe("qcp db use <alias>");
	});

	test("does not expose raw database URLs or API keys", () => {
		const context = buildConfigContext({
			loadConfig: () => configWithConnections(),
			schemaCatalogHasConnection: () => true,
		});

		const serialized = JSON.stringify(context);

		expect(serialized).not.toContain("super-secret");
		expect(serialized).not.toContain("postgres://");
		expect(serialized).not.toContain("AIza-secret");
		expect(serialized).not.toContain("sk-secret");
	});

	test("redacts parseable and unparseable database URLs safely", () => {
		expect(
			redactDatabaseUrl("postgres://readonly:password@db.example.com:5432/app"),
		).toEqual({
			protocol: "postgres",
			host: "db.example.com",
			port: "5432",
			database: "app",
			user: "readonly",
			password: "[REDACTED]",
			parseable: true,
		});
		expect(redactDatabaseUrl("not a url")).toEqual({ parseable: false });
	});
});

function configWithConnections(): QcpConfig {
	return {
		version: "0.1.0",
		installId: "019a0000-0000-7000-8000-000000000000",
		activeDatabaseId: "prod-id",
		databaseConnections: [
			{
				id: "prod-id",
				name: "prod",
				databaseType: "other-postgres",
				databaseUrl: "postgres://readonly:super-secret@db.example.com:5432/app",
				createdAt: "2026-07-04T00:00:00.000Z",
				updatedAt: "2026-07-04T00:00:00.000Z",
			},
			{
				id: "staging-id",
				name: "staging",
				databaseType: "prisma-postgres",
				databaseUrl: "postgres://staging:secret@staging.example.com/app",
				prismaSchemaPath: "prisma/schema.prisma",
				prismaDatasourceName: "db",
				createdAt: "2026-07-04T00:00:00.000Z",
				updatedAt: "2026-07-04T00:00:00.000Z",
			},
		],
		databaseType: "other-postgres",
		databaseUrl: "postgres://readonly:super-secret@db.example.com:5432/app",
		provider: "gemini",
		model: "gemini-2.5-flash",
		telemetry: true,
		safeMode: true,
		showSql: true,
		showMetrics: false,
		sensitiveTablePatterns: [],
		apiKeys: {
			gemini: "AIza-secret",
			openai: "sk-secret",
		},
	};
}
