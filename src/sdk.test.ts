import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeSecureReadQuery } from "./agents/database-tools.js";
import { createQcpClient, QcpSdkRuntimeDependencyError } from "./index.js";
import type {
	ActiveDatabaseConnection,
	DatabaseSchema,
	QcpConfig,
	QueryResult,
} from "./types/index.js";

describe("qcp SDK", () => {
	test("imports without CLI side effects", async () => {
		const writes: string[] = [];
		const originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;

		try {
			const mod = await import("./index.js");
			expect(typeof mod.createQcpClient).toBe("function");
			expect(writes).toEqual([]);
		} finally {
			process.stdout.write = originalWrite;
		}
	});

	test("answers direct schema questions from explicit SDK context", async () => {
		const client = createQcpClient({
			config: configWith({
				provider: "ollama",
				databaseType: "other-postgres",
			}),
			connection: connectionWith({ databaseType: "other-postgres" }),
			schema: schemaWithTables(["users", "orders"]),
			semanticEnabled: false,
		});

		const result = await client.ask("what tables do you know?");

		expect(result.direct).toBe(true);
		expect(result.text).toContain("users");
		expect(result.text).toContain("orders");
		expect(result.connectionName).toBe("sdk-test");
		expect(result.databaseName).toBe("sdk");
		expect(result.provider).toBe("ollama");
	});

	test("throws actionable runtime dependency errors without installing by default", async () => {
		const store = tempStore();
		const client = createQcpClient({
			config: configWith({
				provider: "gemini",
				databaseType: "other-postgres",
			}),
			connection: connectionWith({ databaseType: "other-postgres" }),
			schema: schemaWithTables(["users"]),
			packageStoreDir: store,
			semanticEnabled: false,
		});

		try {
			await client.ask("what tables do you know?");
			throw new Error("expected missing runtime package error");
		} catch (error: unknown) {
			expect(error).toBeInstanceOf(QcpSdkRuntimeDependencyError);
			const sdkError = error as QcpSdkRuntimeDependencyError;
			expect(sdkError.missingGroups).toEqual(["provider-gemini"]);
			expect(sdkError.installCommands).toEqual([
				"qcp packages install provider-gemini --yes",
			]);
			expect(sdkError.targetDir).toBe(store);
		}
	});

	test("fails closed when read queries require approval and no handler is supplied", async () => {
		const result = await executeSecureReadQuery(
			{
				databaseUrl: "postgres://readonly:secret@example.invalid/db",
				schema: schemaWithTables(["users"]),
				sensitiveTablePatterns: ["users"],
				queryExecutor: async (): Promise<QueryResult> => {
					throw new Error("query executor should not run");
				},
			},
			"SELECT * FROM users",
		);

		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error("expected approval-required query to fail closed");
		}
		expect(result.error).toBe("Query requires approval before execution.");
		expect(result.approvalReasons.map((reason) => reason.type)).toContain(
			"sensitive_table",
		);
	});
});

function tempStore(): string {
	const dir = mkdtempSync(join(tmpdir(), "qcp-sdk-packages-test-"));
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ name: "qcp-sdk-test-store", type: "module" }),
	);
	mkdirSync(join(dir, "node_modules"), { recursive: true });
	return dir;
}

function configWith(
	overrides: Pick<QcpConfig, "provider" | "databaseType">,
): QcpConfig {
	return {
		version: "0.1.0",
		installId: "019a0000-0000-7000-8000-000000000000",
		databaseConnections: [],
		databaseType: overrides.databaseType,
		provider: overrides.provider,
		model: overrides.provider === "ollama" ? "qwen3" : "gemini-2.5-flash",
		telemetry: false,
		safeMode: true,
		showSql: true,
		showMetrics: false,
		sensitiveTablePatterns: [],
		apiKeys: {},
	};
}

function connectionWith(
	overrides: Pick<ActiveDatabaseConnection, "databaseType">,
): ActiveDatabaseConnection {
	return {
		id: "sdk-test",
		name: "sdk-test",
		databaseType: overrides.databaseType,
		databaseUrl: "postgres://readonly:secret@example.invalid/db",
	};
}

function schemaWithTables(tableNames: readonly string[]): DatabaseSchema {
	return {
		scannedAt: "2026-07-03T00:00:00.000Z",
		databaseName: "sdk",
		tableCount: tableNames.length,
		tables: tableNames.map((name) => ({
			schema: "public",
			name,
			columns: [
				{
					name: "id",
					type: "text",
					nullable: false,
					isPrimaryKey: true,
				},
			],
			primaryKeys: ["id"],
			foreignKeys: [],
			indexes: [],
		})),
	};
}
