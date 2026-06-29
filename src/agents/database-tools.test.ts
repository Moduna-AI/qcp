import { describe, expect, test } from "bun:test";
import type { ToolsInput } from "@mastra/core/agent";
import type { ToolAction } from "@mastra/core/tools";
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
		const tools = createDatabaseTools({
			databaseUrl: "postgres://example",
			schema,
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
	});

	test("executes processed read-only SQL", async () => {
		let executedSql = "";
		const tools = createDatabaseTools({
			databaseUrl: "postgres://example",
			schema,
			queryExecutor: async (_databaseUrl, sql) => {
				executedSql = sql;
				return emptyResult();
			},
		});

		const result = await executeTool(tools, "qcp_execute_read_sql", {
			sql: "SELECT * FROM projects",
		});
		const output = result as { ok: boolean; result?: QueryResult };

		expect(output.ok).toBe(true);
		expect(output.result?.rowCount).toBe(0);
		expect(executedSql).toMatch(/LIMIT\s+\(?100\)?/i);
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
