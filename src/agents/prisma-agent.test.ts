import { describe, expect, test } from "bun:test";
import type { ToolsInput } from "@mastra/core/agent";
import type { ToolAction } from "@mastra/core/tools";
import type { DatabaseSchema, QueryResult } from "@/types/index.js";
import {
	createPrismaTools,
	loadPrismaMcpToolsets,
	type PrismaMcpToolsetsClient,
} from "./prisma-agent.js";

const schema: DatabaseSchema = {
	scannedAt: "2026-06-28T00:00:00.000Z",
	databaseName: "test",
	tableCount: 1,
	tables: [
		{
			schema: "public",
			name: "users",
			columns: [
				{
					name: "id",
					type: "integer",
					nullable: false,
					isPrimaryKey: true,
				},
				{
					name: "email",
					type: "text",
					nullable: false,
					isPrimaryKey: false,
				},
			],
			primaryKeys: ["id"],
			foreignKeys: [],
			indexes: [],
			estimatedRows: 10,
		},
	],
};

describe("Prisma agent tools", () => {
	test("validates safe SELECT and applies limit", async () => {
		const tools = createPrismaTools({
			databaseUrl: "postgres://example",
			schema,
		});

		const result = await executeTool(tools, "qcp_validate_sql", {
			sql: "SELECT * FROM users",
		});
		const report = result as { safe: boolean; processedSql: string };

		expect(report.safe).toBe(true);
		expect(report.processedSql).toContain("LIMIT 100");
	});

	test("rejects dangerous SQL before execution", async () => {
		let executed = false;
		const tools = createPrismaTools({
			databaseUrl: "postgres://example",
			schema,
			queryExecutor: async () => {
				executed = true;
				return emptyResult();
			},
		});

		const result = await executeTool(tools, "qcp_execute_read_sql", {
			sql: "DELETE FROM users",
		});
		const output = result as { ok: boolean; error?: string };

		expect(output.ok).toBe(false);
		expect(output.error).toMatch(/DELETE/i);
		expect(executed).toBe(false);
	});

	test("executes only processed safe SQL", async () => {
		let executedSql = "";
		const tools = createPrismaTools({
			databaseUrl: "postgres://example",
			schema,
			queryExecutor: async (_databaseUrl, sql) => {
				executedSql = sql;
				return emptyResult();
			},
		});

		const result = await executeTool(tools, "qcp_execute_read_sql", {
			sql: "SELECT * FROM users",
		});
		const output = result as { ok: boolean; result?: QueryResult };

		expect(output.ok).toBe(true);
		expect(output.result?.rowCount).toBe(0);
		expect(executedSql).toContain("LIMIT 100");
	});

	test("falls back cleanly when Prisma MCP tools cannot load", async () => {
		const result = await loadPrismaMcpToolsets("postgres://example", () =>
			failingMcpClient("startup failed"),
		);

		expect(result.toolsets).toEqual({});
		expect(result.errors.prisma).toContain("startup failed");
		await result.disconnect();
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

function failingMcpClient(message: string): PrismaMcpToolsetsClient {
	return {
		async listToolsetsWithErrors() {
			throw new Error(message);
		},
		async disconnect() {},
	};
}
