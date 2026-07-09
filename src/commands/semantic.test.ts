import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	DatabaseSchema,
	QcpConfig,
	SchemaCatalog,
} from "@/types/index.js";

describe("qcp semantic command smoke tests", () => {
	test("semantic status reports an empty temp home without creating a store", () => {
		const home = tempHome();
		const result = runQcp(home, ["semantic", "status"]);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("No semantic store found");
		expect(existsSync(join(home, ".qcp", "semantic.db"))).toBe(false);
	});

	test("semantic enrich syncs catalog objects and skips prompts in non-interactive mode", () => {
		const home = tempHome();
		writeConfigAndSchema(home);
		seedRuntimePackage(home, "@libsql/client");
		seedRuntimePackage(home, "@libsql/core");

		const result = runQcp(home, [
			"semantic",
			"enrich",
			"--database",
			"local",
			"--table",
			"users",
		]);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("No semantic objects need enrichment");
		expect(existsSync(join(home, ".qcp", "semantic.db"))).toBe(true);
	});

	test("semantic profile validates table selectors before querying data", () => {
		const home = tempHome();
		writeConfigAndSchema(home);
		seedRuntimePackage(home, "@libsql/client");
		seedRuntimePackage(home, "@libsql/core");

		const result = runQcp(home, [
			"semantic",
			"profile",
			"missing_table",
			"--database",
			"local",
			"--column",
			"status",
		]);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Table not found");
	});
});

interface QcpRunResult {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

function runQcp(home: string, args: readonly string[]): QcpRunResult {
	const result = spawnSync(
		process.execPath,
		["run", "src/cli/index.ts", ...args],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				HOMEDRIVE: "",
				HOMEPATH: home,
				CI: "1",
			},
			encoding: "utf-8",
		},
	);
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

function tempHome(): string {
	return mkdtempSync(join(tmpdir(), "qcp-semantic-command-home-"));
}

function seedRuntimePackage(home: string, packageName: string): void {
	const packageStore = join(home, ".qcp", "packages");
	const packageDir = join(
		packageStore,
		"node_modules",
		...packageName.split("/"),
	);
	mkdirSync(
		join(packageStore, "node_modules", ...packageName.split("/").slice(0, -1)),
		{
			recursive: true,
		},
	);
	writeFileSync(
		join(packageStore, "package.json"),
		JSON.stringify({
			name: "qcp-test-runtime-packages",
			private: true,
			type: "module",
			dependencies: {},
		}),
	);
	if (!existsSync(packageDir)) {
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: packageName,
				version: "0.0.0-test",
				type: "module",
				exports: {
					".": "./index.js",
				},
			}),
		);
		writeFileSync(
			join(packageDir, "index.js"),
			`
import { writeFileSync } from 'node:fs'

export function createClient(config) {
  const path = String(config.url ?? '').replace(/^file:/, '')
  if (path && path !== ':memory:' && path !== ':memory') {
    writeFileSync(path, '', { flag: 'a' })
  }
  return {
    async execute() {
      return { rows: [] }
    },
    close() {}
  }
}
`.trim(),
		);
	}
}

function writeConfigAndSchema(home: string): void {
	const qcpHome = join(home, ".qcp");
	mkdirSync(qcpHome, { recursive: true });
	const config: QcpConfig = {
		version: "0.2.4",
		installId: "019a0000-0000-7000-8000-000000000000",
		databaseConnections: [
			{
				id: "conn-1",
				name: "local",
				databaseType: "other-postgres",
				databaseUrl: "postgres://example/app",
				createdAt: "2026-07-03T00:00:00.000Z",
				updatedAt: "2026-07-03T00:00:00.000Z",
			},
		],
		activeDatabaseId: "conn-1",
		databaseType: "other-postgres",
		databaseUrl: "postgres://example/app",
		provider: "gemini",
		model: "gemini-2.5-flash",
		telemetry: false,
		safetyLevel: "standard",
		safeMode: true,
		showSql: true,
		showMetrics: false,
		sensitiveTablePatterns: ["email"],
		apiKeys: {},
	};
	const catalog: SchemaCatalog = {
		version: "1",
		schemas: [
			{
				connectionId: "conn-1",
				connectionName: "local",
				databaseType: "other-postgres",
				databaseName: "app",
				scannedAt: schema().scannedAt,
				schema: schema(),
			},
		],
	};
	writeFileSync(join(qcpHome, "config.json"), JSON.stringify(config, null, 2));
	writeFileSync(
		join(qcpHome, "schemas.json"),
		JSON.stringify(catalog, null, 2),
	);
}

function schema(): DatabaseSchema {
	return {
		scannedAt: "2026-07-03T00:00:00.000Z",
		databaseName: "app",
		tableCount: 1,
		tables: [
			{
				schema: "public",
				name: "users",
				primaryKeys: ["id"],
				columns: [
					{ name: "id", type: "integer", nullable: false, isPrimaryKey: true },
					{ name: "status", type: "text", nullable: true, isPrimaryKey: false },
					{ name: "email", type: "text", nullable: true, isPrimaryKey: false },
				],
				foreignKeys: [],
				indexes: [],
			},
		],
	};
}
