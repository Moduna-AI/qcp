import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolsInput } from "@mastra/core/agent";
import type { ToolAction } from "@mastra/core/tools";
import type { AuditRecord } from "@/logger/audit.js";
import { DatabaseTransferService } from "@/transfer/database-transfer-service.js";
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
				{
					name: "customer_id",
					type: "integer",
					nullable: false,
					isPrimaryKey: false,
				},
				{
					name: "status",
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

	test("low safety skips sensitive read approval but keeps validation", async () => {
		let executed = false;
		const tools = createDatabaseTools({
			databaseUrl: "postgres://example",
			schema,
			safetyLevel: "low",
			sensitiveTablePatterns: ["projects"],
			approvalHandler: async () => false,
			queryExecutor: async () => {
				executed = true;
				return emptyResult();
			},
		});

		const result = await executeTool(tools, "qcp_execute_read_sql", {
			sql: "SELECT * FROM projects",
		});
		const output = result as { ok: boolean };

		expect(output.ok).toBe(true);
		expect(executed).toBe(true);
	});

	test("suggests query improvements from a safe explain plan", async () => {
		const tools = createDatabaseTools({
			databaseUrl: "postgres://example",
			schema,
			explainExecutor: async () => ({
				estimatedRows: 180,
				plan: explainPlan({
					"Node Type": "Seq Scan",
					"Relation Name": "projects",
					Schema: "public",
					Filter: "((customer_id = 5) AND (status = 'pending'::text))",
					"Plan Rows": 180,
					"Total Cost": 340,
				}),
			}),
		});

		const result = await executeTool(tools, "qcp_suggest_query_improvements", {
			sql: "SELECT * FROM projects WHERE customer_id = 5 AND status = 'pending'",
		});
		const output = result as {
			ok: boolean;
			analysis?: {
				suggestedIndexes: Array<{ suggestionSql?: string }>;
			};
		};

		expect(output.ok).toBe(true);
		expect(output.analysis?.suggestedIndexes[0]?.suggestionSql).toBe(
			"CREATE INDEX idx_projects_customer_id_status ON projects(customer_id, status);",
		);
	});

	test("rejects unsafe SQL before query improvement analysis", async () => {
		let explained = false;
		const tools = createDatabaseTools({
			databaseUrl: "postgres://example",
			schema,
			explainExecutor: async () => {
				explained = true;
				return { plan: "[]", estimatedRows: 0 };
			},
		});

		const result = await executeTool(tools, "qcp_suggest_query_improvements", {
			sql: "DROP TABLE projects",
		});
		const output = result as { ok: boolean; error?: string };

		expect(output.ok).toBe(false);
		expect(output.error).toMatch(/DROP/i);
		expect(explained).toBe(false);
	});

	test("denies query improvement analysis when approval is rejected", async () => {
		let explained = false;
		const tools = createDatabaseTools({
			databaseUrl: "postgres://example",
			schema,
			sensitiveTablePatterns: ["projects"],
			approvalHandler: async () => false,
			explainExecutor: async () => {
				explained = true;
				return { plan: "[]", estimatedRows: 0 };
			},
		});

		const result = await executeTool(tools, "qcp_suggest_query_improvements", {
			sql: "SELECT * FROM projects",
		});
		const output = result as { ok: boolean; error?: string };

		expect(output.ok).toBe(false);
		expect(output.error).toMatch(/approval/i);
		expect(explained).toBe(false);
	});

	test("sanitizes query improvement plan output", async () => {
		const tools = createDatabaseTools({
			databaseUrl: "postgres://example",
			schema,
			explainExecutor: async () => ({
				estimatedRows: 1,
				plan: explainPlan({
					"Node Type": "Seq Scan",
					"Relation Name": "projects",
					Schema: "public",
					Filter: "(name = 'ada@example.com'::text)",
					"Plan Rows": 1,
					"Total Cost": 4,
				}),
			}),
		});

		const result = await executeTool(tools, "qcp_suggest_query_improvements", {
			sql: "SELECT * FROM projects WHERE name = 'ada@example.com'",
		});
		const output = result as { ok: boolean; plan?: string };

		expect(output.ok).toBe(true);
		expect(output.plan).not.toContain("ada@example.com");
		expect(output.plan).toContain("[REDACTED_EMAIL]");
	});

	test("exports database data through the shared Mastra tool", async () => {
		const dir = mkdtempSync(join(tmpdir(), "qcp-transfer-tool-"));
		const tools = createDatabaseTools({
			databaseUrl: "postgres://example",
			schema,
			transferService: new DatabaseTransferService({
				databaseUrl: "postgres://example",
				schema,
				cwd: dir,
				queryExecutor: async () => ({
					rows: [{ id: 1, name: "Ada" }],
					rowCount: 1,
					fields: ["id", "name"],
					executionTimeMs: 1,
				}),
			}),
		});

		const result = await executeTool(tools, "qcp_export_database_data", {
			filePath: "projects.json",
			table: { table: "projects" },
		});
		const output = result as {
			ok: boolean;
			rowCount?: number;
			filePath?: string;
		};

		expect(output.ok).toBe(true);
		expect(output.rowCount).toBe(1);
		expect(output.filePath).toBe(join(dir, "projects.json"));
		expect(readFileSync(join(dir, "projects.json"), "utf-8")).toContain("Ada");
	});

	test("strict safety requires approval before export", async () => {
		const dir = mkdtempSync(join(tmpdir(), "qcp-transfer-tool-"));
		const tools = createDatabaseTools({
			databaseUrl: "postgres://example",
			schema,
			safetyLevel: "strict",
			transferService: new DatabaseTransferService({
				databaseUrl: "postgres://example",
				schema,
				cwd: dir,
				queryExecutor: async () => emptyResult(),
			}),
		});

		const result = await executeTool(tools, "qcp_export_database_data", {
			filePath: "projects.json",
			table: { table: "projects" },
		});
		const output = result as { ok: boolean; error?: string };

		expect(output.ok).toBe(false);
		expect(output.error).toMatch(/approval/i);
	});

	test("requires approval before import creates a table", async () => {
		const dir = mkdtempSync(join(tmpdir(), "qcp-transfer-tool-"));
		writeFileSync(join(dir, "projects.csv"), "id,name\n1,Ada\n");
		let imported = false;
		const tools = createDatabaseTools({
			databaseUrl: "postgres://example",
			schema,
			transferService: new DatabaseTransferService({
				databaseUrl: "postgres://example",
				schema,
				cwd: dir,
				tableExists: async () => false,
				importExecutor: async () => {
					imported = true;
					return { rowCount: 1 };
				},
			}),
		});

		const result = await executeTool(tools, "qcp_import_database_data", {
			filePath: "projects.csv",
		});
		const output = result as { ok: boolean; error?: string };

		expect(output.ok).toBe(false);
		expect(output.error).toMatch(/approval/i);
		expect(imported).toBe(false);
	});

	test("imports database data when approval is granted", async () => {
		const dir = mkdtempSync(join(tmpdir(), "qcp-transfer-tool-"));
		writeFileSync(join(dir, "customers.json"), '[{"id":1,"name":"Ada"}]\n');
		let approvedOperation = "";
		let importedRows = 0;
		const tools = createDatabaseTools({
			databaseUrl: "postgres://example",
			schema,
			approvalHandler: async (_reasons, operation) => {
				approvedOperation = operation;
				return true;
			},
			transferService: new DatabaseTransferService({
				databaseUrl: "postgres://example",
				schema,
				cwd: dir,
				tableExists: async () => false,
				importExecutor: async (input) => {
					importedRows = input.rows.length;
					return { rowCount: input.rows.length };
				},
			}),
		});

		const result = await executeTool(tools, "qcp_import_database_data", {
			filePath: "customers.json",
		});
		const output = result as { ok: boolean; rowCount?: number };

		expect(output.ok).toBe(true);
		expect(output.rowCount).toBe(1);
		expect(importedRows).toBe(1);
		expect(approvedOperation).toContain("IMPORT customers.json");
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

function explainPlan(plan: Record<string, unknown>): string {
	return JSON.stringify([
		{
			"QUERY PLAN": [
				{
					Plan: plan,
				},
			],
		},
	]);
}
