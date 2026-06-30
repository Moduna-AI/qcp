import { describe, expect, test } from "bun:test";
import type { ToolsInput } from "@mastra/core/agent";
import type { ToolAction } from "@mastra/core/tools";
import type { DatabaseSchema, QcpConfig } from "@/types/index.js";
import { createMastraModelConfig } from "./model-config.js";
import { createSupabaseTools, SupabaseAgent } from "./supabase-agent.js";

const schema: DatabaseSchema = {
	scannedAt: "2026-06-29T00:00:00.000Z",
	databaseName: "postgres",
	tableCount: 4,
	tables: [
		{
			schema: "public",
			name: "projects",
			columns: [],
			primaryKeys: [],
			foreignKeys: [],
			indexes: [],
		},
		{
			schema: "auth",
			name: "users",
			columns: [],
			primaryKeys: [],
			foreignKeys: [],
			indexes: [],
		},
		{
			schema: "storage",
			name: "objects",
			columns: [],
			primaryKeys: [],
			foreignKeys: [],
			indexes: [],
		},
		{
			schema: "analytics",
			name: "events",
			columns: [],
			primaryKeys: [],
			foreignKeys: [],
			indexes: [],
		},
	],
};

describe("supabase database agent", () => {
	test("reports the supabase database type", () => {
		const agent = createAgent();

		expect(agent.getDatabaseType()).toBe("supabase");
	});

	test("includes Supabase-specific read-only instructions", async () => {
		const agent = createAgent();
		const instructions = await agent.getAgent().getInstructions();
		const text = Array.isArray(instructions)
			? instructions.join("\n")
			: String(instructions);

		expect(text).toContain("Supabase-hosted PostgreSQL");
		expect(text).toContain("public schema");
		expect(text).toContain("auth schema");
		expect(text).toContain("storage schema");
		expect(text).toContain("Row Level Security");
		expect(text).toContain("service-role");
		expect(text).toContain("end-user access");
		expect(text).toContain("search_docs");
		expect(text).toContain("project-scoped");
		expect(text).toContain("read-only MCP");
	});

	test("adds generic read-only tools plus Supabase context", () => {
		const tools = createSupabaseTools({
			databaseUrl:
				"postgresql://postgres:secret@db.abcdefghijklmnopqrst.supabase.co:5432/postgres",
			schema,
		});

		expect(Object.keys(tools).sort()).toEqual([
			"qcp_execute_read_sql",
			"qcp_explain_read_sql",
			"qcp_read_database_context",
			"qcp_read_supabase_context",
			"qcp_validate_sql",
		]);
	});

	test("infers direct Supabase project host and ref without credentials", async () => {
		const tools = createSupabaseTools({
			databaseUrl:
				"postgresql://postgres:secret@db.abcdefghijklmnopqrst.supabase.co:5432/postgres",
			schema,
		});

		const context = (await executeTool(
			tools,
			"qcp_read_supabase_context",
			{},
		)) as SupabaseContextOutput;
		const serialized = JSON.stringify(context);

		expect(context.projectHost).toBe("db.abcdefghijklmnopqrst.supabase.co");
		expect(context.projectRef).toBe("abcdefghijklmnopqrst");
		expect(context.detectedSchemas).toEqual([
			"analytics",
			"auth",
			"public",
			"storage",
		]);
		expect(context.supabaseSchemas).toEqual([
			{ schema: "auth", tables: ["users"] },
			{ schema: "public", tables: ["projects"] },
			{ schema: "storage", tables: ["objects"] },
		]);
		expect(context.rlsGuidance).toContain("Row Level Security");
		expect(context.mcpGuidance).toContain("qcp auth");
		expect(context.mcpGuidance).toContain("read_only=true");
		expect(context.mcpGuidance).toContain("search_docs");
		expect(serialized).not.toContain("secret");
	});

	test("infers pooler project ref from the connection username", async () => {
		const tools = createSupabaseTools({
			databaseUrl:
				"postgres://postgres.abcdefghijklmnopqrst:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
			schema,
		});

		const context = (await executeTool(
			tools,
			"qcp_read_supabase_context",
			{},
		)) as SupabaseContextOutput;
		const serialized = JSON.stringify(context);

		expect(context.projectHost).toBe("aws-0-us-east-1.pooler.supabase.com");
		expect(context.projectRef).toBe("abcdefghijklmnopqrst");
		expect(serialized).not.toContain("secret");
		expect(serialized).not.toContain("postgres.abcdefghijklmnopqrst");
	});
});

interface SupabaseContextOutput {
	readonly projectHost?: string;
	readonly projectRef?: string;
	readonly detectedSchemas: readonly string[];
	readonly supabaseSchemas: ReadonlyArray<{
		readonly schema: string;
		readonly tables: readonly string[];
	}>;
	readonly rlsGuidance: string;
	readonly mcpGuidance: string;
}

function createAgent(): SupabaseAgent<"qcp-supabase-agent"> {
	const config = configWithDatabaseType("supabase");

	return new SupabaseAgent({
		id: "qcp-supabase-agent",
		name: "QCP Supabase Database Agent",
		description:
			"Answers questions about Supabase-hosted PostgreSQL databases using qcp read-only database tools.",
		model: createMastraModelConfig(config),
		databaseUrl:
			"postgresql://postgres:secret@db.abcdefghijklmnopqrst.supabase.co:5432/postgres",
		schema,
	});
}

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

function configWithDatabaseType(
	databaseType: QcpConfig["databaseType"],
): QcpConfig {
	return {
		version: "0.1.0",
		installId: "019a0000-0000-7000-8000-000000000000",
		databaseType,
		provider: "gemini",
		model: "gemini-2.5-flash",
		telemetry: true,
		safeMode: true,
		showSql: true,
		showMetrics: false,
		sensitiveTablePatterns: [],
		apiKeys: {},
	};
}
