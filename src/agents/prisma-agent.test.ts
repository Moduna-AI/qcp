import { describe, expect, test } from "bun:test";
import type { ToolsInput } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
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
				{
					name: "organization_id",
					type: "text",
					nullable: false,
					isPrimaryKey: false,
				},
				{
					name: "user_id",
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

		const result = await executeTool(
			tools,
			"qcp_execute_read_sql",
			{
				sql: "DELETE FROM users",
			},
			secureContext(),
		);
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

		const result = await executeTool(
			tools,
			"qcp_execute_read_sql",
			{
				sql: "SELECT id, organization_id, user_id FROM users",
			},
			secureContext(),
		);
		const output = result as { ok: boolean; result?: QueryResult };

		expect(output.ok).toBe(true);
		expect(output.result?.rowCount).toBe(0);
		expect(executedSql).toMatch(/LIMIT\s+\(?100\)?/i);
		expect(executedSql).toContain("organization_id");
		expect(executedSql).toContain("org_123");
		expect(executedSql).toContain("user_id");
		expect(executedSql).toContain("user_456");
	});

	test("requires trusted tenant context before execution", async () => {
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
			sql: "SELECT * FROM users",
		});
		const output = result as { error?: boolean; message?: string };

		expect(output.error).toBe(true);
		expect(output.message).toMatch(/request context validation failed/i);
		expect(executed).toBe(false);
	});

	test("scrubs query results before returning tool output", async () => {
		const tools = createPrismaTools({
			databaseUrl: "postgres://example",
			schema,
			queryExecutor: async () => ({
				rows: [
					{
						email: "ada@example.com",
						phone: "415-555-1212",
						token:
							"Bearer abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
					},
				],
				rowCount: 1,
				fields: ["email", "phone", "token"],
				executionTimeMs: 1,
			}),
		});

		const result = await executeTool(
			tools,
			"qcp_execute_read_sql",
			{
				sql: "SELECT id, organization_id, user_id FROM users",
			},
			secureContext(),
		);
		const output = result as { ok: boolean; result?: QueryResult };
		const serialized = JSON.stringify(output);

		expect(output.ok).toBe(true);
		expect(serialized).not.toContain("ada@example.com");
		expect(serialized).not.toContain("415-555-1212");
		expect(serialized).toContain("[REDACTED_EMAIL]");
	});

	test("scrubs model-facing tool output", async () => {
		const tools = createPrismaTools({
			databaseUrl: "postgres://example",
			schema,
		});
		const tool = tools.qcp_execute_read_sql as
			| ToolAction<unknown, unknown, unknown, unknown>
			| undefined;

		const modelOutput = tool?.toModelOutput?.({
			ok: true,
			result: {
				rows: [{ email: "ada@example.com" }],
			},
		});

		expect(JSON.stringify(modelOutput)).not.toContain("ada@example.com");
		expect(JSON.stringify(modelOutput)).toContain("[REDACTED_EMAIL]");
	});

	test("returns configured Prisma schema context", async () => {
		const tools = createPrismaTools({
			databaseUrl: "postgres://example",
			schema,
			prismaSchemaPath: "prisma/schema.prisma",
			prismaDatasourceName: "db",
		});

		const result = await executeTool(tools, "qcp_read_prisma_context", {});
		const output = result as {
			prismaSchemaPath?: string;
			prismaDatasourceName?: string;
		};

		expect(output.prismaSchemaPath).toBe("prisma/schema.prisma");
		expect(output.prismaDatasourceName).toBe("db");
	});

	test("requires approval for sensitive or high-cost queries", async () => {
		const sensitiveTools = createPrismaTools({
			databaseUrl: "postgres://example",
			schema,
			sensitiveTablePatterns: ["users"],
			explainExecutor: async () => ({ plan: "[]", estimatedRows: 1 }),
		});
		const highCostTools = createPrismaTools({
			databaseUrl: "postgres://example",
			schema,
			explainExecutor: async () => ({ plan: "[]", estimatedRows: 20_001 }),
		});

		const sensitive = await requiresApproval(
			sensitiveTools,
			"qcp_execute_read_sql",
			{ sql: "SELECT id, organization_id, user_id FROM users" },
		);
		const highCost = await requiresApproval(
			highCostTools,
			"qcp_execute_read_sql",
			{ sql: "SELECT id, organization_id, user_id FROM users" },
		);

		expect(sensitive).toBe(true);
		expect(highCost).toBe(true);
	});

	test("falls back cleanly when Prisma MCP tools cannot load", async () => {
		const result = await loadPrismaMcpToolsets("postgres://example", async () =>
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
	context: unknown = {},
): Promise<unknown> {
	const tool = tools[name] as
		| ToolAction<unknown, unknown, unknown, unknown>
		| undefined;
	if (!tool?.execute) {
		throw new Error(`Tool not found: ${name}`);
	}

	return tool.execute(input, context as never);
}

async function requiresApproval(
	tools: ToolsInput,
	name: string,
	input: unknown,
): Promise<boolean> {
	const tool = tools[name] as
		| ToolAction<unknown, unknown, unknown, unknown>
		| undefined;
	if (!tool?.requireApproval) {
		throw new Error(`Approval hook not found: ${name}`);
	}
	if (tool.requireApproval === true) return true;

	const approval = tool.requireApproval(input, secureApprovalContext());
	return typeof approval === "boolean" ? approval : await approval;
}

function secureContext(): {
	requestContext: RequestContext<{ tenantId: string; userId: string }>;
} {
	const requestContext = new RequestContext<{
		tenantId: string;
		userId: string;
	}>();
	requestContext.set("tenantId", "org_123");
	requestContext.set("userId", "user_456");

	return {
		requestContext,
	};
}

function secureApprovalContext(): {
	requestContext: Record<string, unknown>;
} {
	return {
		requestContext: {
			tenantId: "org_123",
			userId: "user_456",
		},
	};
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
