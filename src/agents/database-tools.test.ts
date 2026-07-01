import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolsInput } from "@mastra/core/agent";
import type { ToolAction } from "@mastra/core/tools";
import type { AuditRecord } from "@/logger/audit.js";
import type { DatabaseSchema, QueryResult } from "@/types/index.js";
import { createDatabaseTools } from "./database-tools.js";

const schema: DatabaseSchema = {
	scannedAt: "2026-06-29T00:00:00.000Z",
	databaseName: "test",
	tableCount: 1,
	tables: [
		{
			schema: "public",
			name: "projects",
			columns: [
				{
					name: "id",
					type: "integer",
					nullable: false,
					isPrimaryKey: true,
				},
				{
					name: "name",
					type: "text",
					nullable: false,
					isPrimaryKey: false,
				},
			],
			primaryKeys: ["id"],
			foreignKeys: [],
			indexes: [],
			estimatedRows: 4,
		},
	],
};

describe("shared database agent tools", () => {
	test("rejects unsafe SQL before execution", async () => {
		let executed = false;
		const logsDir = mkdtempSync(join(tmpdir(), "qcp-audit-tools-"));
		const tools = createDatabaseTools({
			databaseUrl: "postgres://example",
			schema,
			auditContext: auditContext(logsDir),
			queryExecutor: async () => {
				executed = true;
				return emptyResult();
			},
		});

		const result = await executeTool(tools, "qcp_execute_read_sql", {
			sql: "DELETE FROM projects",
		});
		const output = result as { ok: boolean; error?: string };

		expect(output.ok).toBe(false);
		expect(output.error).toMatch(/DELETE/i);
		expect(executed).toBe(false);
		const records = readAuditRecords(logsDir);
		expect(records.at(-1)?.action).toBe("QUERY_REJECTED");
		expect(records.at(-1)?.outcome).toBe("rejected");
	});

	test("executes processed read-only SQL", async () => {
		let executedSql = "";
		const logsDir = mkdtempSync(join(tmpdir(), "qcp-audit-tools-"));
		const tools = createDatabaseTools({
			databaseUrl: "postgres://example",
			schema,
			auditContext: auditContext(logsDir),
			queryExecutor: async (_databaseUrl, sql) => {
				executedSql = sql;
				return {
					rows: [
						{
							email: "ada@example.com",
							api_key: "supersecretvalue",
						},
					],
					rowCount: 1,
					fields: ["email", "api_key"],
					executionTimeMs: 3,
				};
			},
		});

		const result = await executeTool(tools, "qcp_execute_read_sql", {
			sql: "SELECT * FROM projects",
		});
		const output = result as { ok: boolean; result?: QueryResult };

		expect(output.ok).toBe(true);
		expect(output.result?.rowCount).toBe(1);
		expect(executedSql).toMatch(/LIMIT\s+\(?100\)?/i);
		const content = readFileSync(join(logsDir, "audit.jsonl"), "utf-8");
		expect(content).not.toContain("ada@example.com");
		expect(content).not.toContain("supersecretvalue");
		const records = readAuditRecords(logsDir);
		expect(records.at(-1)?.action).toBe("READ");
		expect(records.at(-1)?.outcome).toBe("success");
		expect(records.at(-1)?.metadata).toMatchObject({
			result: {
				rowCount: 1,
				fields: ["email", "api_key"],
				executionTimeMs: 3,
			},
		});
	});

	test("audits approval denial without executing SQL", async () => {
		let executed = false;
		const logsDir = mkdtempSync(join(tmpdir(), "qcp-audit-tools-"));
		const tools = createDatabaseTools({
			databaseUrl: "postgres://example",
			schema,
			sensitiveTablePatterns: ["projects"],
			auditContext: auditContext(logsDir),
			approvalHandler: async () => false,
			queryExecutor: async () => {
				executed = true;
				return emptyResult();
			},
		});

		const result = await executeTool(tools, "qcp_execute_read_sql", {
			sql: "SELECT * FROM projects",
		});
		const output = result as { ok: boolean; error?: string };

		expect(output.ok).toBe(false);
		expect(output.error).toMatch(/approval/i);
		expect(executed).toBe(false);
		const records = readAuditRecords(logsDir);
		expect(
			records.some((record) => record.action === "APPROVAL_REQUIRED"),
		).toBe(true);
		expect(records.some((record) => record.action === "APPROVAL_DENIED")).toBe(
			true,
		);
	});
});

async function executeTool(
	tools: ToolsInput,
	name: string,
	input: unknown,
): Promise<unknown> {
	const tool = tools[name] as
		| ToolAction<unknown, unknown, unknown, unknown>
		| undefined;
	if (!tool?.execute) {
		throw new Error(`Tool not found: ${name}`);
	}

	return tool.execute(input, {} as never);
}

function emptyResult(): QueryResult {
	return {
		rows: [],
		rowCount: 0,
		fields: [],
		executionTimeMs: 1,
	};
}

function auditContext(logsDir: string) {
	return {
		logsDir,
		command: "test",
		installId: "install-1",
		connectionId: "conn-1",
		connectionName: "test",
		databaseType: "other-postgres" as const,
		databaseName: "test",
		provider: "gemini" as const,
		model: "gemini-test",
	};
}

function readAuditRecords(logsDir: string): AuditRecord[] {
	return readFileSync(join(logsDir, "audit.jsonl"), "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as AuditRecord);
}
