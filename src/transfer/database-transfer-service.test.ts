import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSchema, QueryResult } from "@/types/index.js";
import {
	DatabaseTransferService,
	deriveTableNameFromPath,
	normalizeIdentifier,
} from "./database-transfer-service.js";
import { listSupportedTransferFormats } from "./format-adapters.js";

const schema: DatabaseSchema = {
	scannedAt: "2026-07-04T00:00:00.000Z",
	databaseName: "test",
	tableCount: 1,
	tables: [
		{
			schema: "public",
			name: "projects",
			columns: [],
			primaryKeys: [],
			foreignKeys: [],
			indexes: [],
		},
	],
};

describe("database transfer service", () => {
	test("exports query rows to csv inside the workspace", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "qcp-transfer-"));
		const service = new DatabaseTransferService({
			databaseUrl: "postgres://example",
			schema,
			cwd,
			queryExecutor: async () => resultWithRows(),
		});

		const output = await service.exportData({
			filePath: "exports/projects.csv",
			sql: "SELECT * FROM projects",
		});

		expect(output.ok).toBe(true);
		if (!output.ok) throw new Error(output.error);
		expect(output.rowCount).toBe(2);
		const content = readFileSync(join(cwd, "exports", "projects.csv"), "utf-8");
		expect(content).toContain("id,name");
		expect(content).toContain('2,"Grace, Hopper"');
	});

	test("rejects export paths outside the workspace", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "qcp-transfer-"));
		const service = new DatabaseTransferService({
			databaseUrl: "postgres://example",
			schema,
			cwd,
			queryExecutor: async () => resultWithRows(),
		});

		await expect(
			service.exportData({
				filePath: "../outside.csv",
				sql: "SELECT * FROM projects",
			}),
		).rejects.toThrow(/outside the current working directory/i);
	});

	test("imports jsonl rows into a filename-derived new table", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "qcp-transfer-"));
		const filePath = join(cwd, "new-projects.jsonl");
		writeFileSync(
			filePath,
			`${JSON.stringify({ id: 1, name: "Ada" })}\n${JSON.stringify({
				id: 2,
				name: "Grace",
			})}\n`,
		);
		let importedTable = "";
		let refreshed = false;
		const service = new DatabaseTransferService({
			databaseUrl: "postgres://example",
			schema,
			cwd,
			tableExists: async () => false,
			importExecutor: async (input) => {
				importedTable = `${input.schemaName}.${input.tableName}`;
				expect(input.columns).toEqual(["id", "name"]);
				return { rowCount: input.rows.length };
			},
			refreshSchema: async () => {
				refreshed = true;
			},
		});

		const output = await service.importData({ filePath: "new-projects.jsonl" });

		expect(output.ok).toBe(true);
		if (!output.ok) throw new Error(output.error);
		expect(output.rowCount).toBe(2);
		expect(importedTable).toBe("public.new_projects");
		expect(refreshed).toBe(true);
	});

	test("exports query rows to a SQL dump text file", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "qcp-transfer-"));
		const service = new DatabaseTransferService({
			databaseUrl: "postgres://example",
			schema,
			cwd,
			queryExecutor: async () => resultWithRows(),
		});

		const output = await service.exportData({
			filePath: "projects.sql",
			sql: "SELECT * FROM projects",
		});

		expect(output.ok).toBe(true);
		if (!output.ok) throw new Error(output.error);
		const content = readFileSync(join(cwd, "projects.sql"), "utf-8");
		expect(content).toContain("CREATE TABLE qcp_export");
		expect(content).toContain("INSERT INTO qcp_export");
		expect(content).toContain("'Grace, Hopper'");
	});

	test("imports plain PostgreSQL dump inserts into a new table", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "qcp-transfer-"));
		writeFileSync(
			join(cwd, "projects.sql"),
			[
				"CREATE TABLE qcp_export (",
				'  "id" text,',
				'  "name" text',
				");",
				"INSERT INTO qcp_export (\"id\", \"name\") VALUES ('1', 'Ada'), ('2', 'Grace''s project');",
			].join("\n"),
		);
		let rows: readonly Record<string, unknown>[] = [];
		const service = new DatabaseTransferService({
			databaseUrl: "postgres://example",
			schema,
			cwd,
			tableExists: async () => false,
			importExecutor: async (input) => {
				rows = input.rows;
				expect(input.columns).toEqual(["id", "name"]);
				return { rowCount: input.rows.length };
			},
		});

		const output = await service.importData({ filePath: "projects.sql" });

		expect(output.ok).toBe(true);
		if (!output.ok) throw new Error(output.error);
		expect(output.rowCount).toBe(2);
		expect(rows[1]).toEqual({ id: 2, name: "Grace's project" });
	});

	test("reports optional package requirements for parquet without throwing", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "qcp-transfer-"));
		const service = new DatabaseTransferService({
			databaseUrl: "postgres://example",
			schema,
			cwd,
			queryExecutor: async () => resultWithRows(),
		});

		const output = await service.exportData({
			filePath: "projects.parquet",
			sql: "SELECT * FROM projects",
		});

		if (output.ok) return;
		expect(output.error).toContain("format-parquet");
		expect(output.error).toContain("qcp packages install format-parquet --yes");
	});

	test("reports optional package requirements for pandas pickle export", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "qcp-transfer-"));
		const service = new DatabaseTransferService({
			databaseUrl: "postgres://example",
			schema,
			cwd,
			queryExecutor: async () => resultWithRows(),
		});

		const output = await service.exportData({
			filePath: "projects.pd",
			sql: "SELECT * FROM projects",
		});

		if (output.ok) return;
		expect(output.error).toContain("format-pandas");
		expect(output.error).toContain("qcp packages install format-pandas --yes");
	});

	test("refuses pandas pickle import for safety", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "qcp-transfer-"));
		writeFileSync(join(cwd, "frame.pd"), "not a pickle");
		const service = new DatabaseTransferService({
			databaseUrl: "postgres://example",
			schema,
			cwd,
		});

		const output = await service.importData({ filePath: "frame.pd" });

		expect(output.ok).toBe(false);
		if (output.ok) throw new Error("expected pandas import to fail");
		expect(output.error).toContain("pickle files can execute code");
	});

	test("rejects import when the destination table already exists", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "qcp-transfer-"));
		writeFileSync(join(cwd, "projects.csv"), "id,name\n1,Ada\n");
		const service = new DatabaseTransferService({
			databaseUrl: "postgres://example",
			schema,
			cwd,
			tableExists: async () => true,
		});

		const output = await service.importData({ filePath: "projects.csv" });

		expect(output.ok).toBe(false);
		if (output.ok) throw new Error("expected import to fail");
		expect(output.error).toMatch(/already exists/i);
	});

	test("normalizes identifiers and filename table names", () => {
		expect(normalizeIdentifier("2026 Leads!")).toBe("t_2026_leads");
		expect(deriveTableNameFromPath("/tmp/Customer Leads.csv")).toBe(
			"customer_leads",
		);
	});

	test("lists broad import and export format choices", () => {
		expect(listSupportedTransferFormats("import")).toEqual([
			"csv",
			"tsv",
			"json",
			"jsonl",
			"parquet",
			"sqlite",
			"postgres-dump",
		]);
		expect(listSupportedTransferFormats("export")).toEqual([
			"csv",
			"tsv",
			"json",
			"jsonl",
			"parquet",
			"sqlite",
			"pandas",
			"postgres-dump",
		]);
	});
});

function resultWithRows(): QueryResult {
	return {
		rows: [
			{ id: 1, name: "Ada" },
			{ id: 2, name: "Grace, Hopper" },
		],
		rowCount: 2,
		fields: ["id", "name"],
		executionTimeMs: 1,
	};
}
