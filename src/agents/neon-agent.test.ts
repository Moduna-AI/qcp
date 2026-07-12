import { describe, expect, test } from "bun:test";
import type { ToolsInput } from "@mastra/core/agent";
import type { ToolAction } from "@mastra/core/tools";
import type { DatabaseSchema, QcpConfig } from "@/types/index.js";
import { createMastraModelConfig } from "./model-config.js";
import {
	createNeonTools,
	inferNeonConnection,
	loadNeonMcpDocsContext,
	NeonAgent,
	type NeonMcpDocsClient,
} from "./neon-agent.js";

const schema: DatabaseSchema = {
	scannedAt: "2026-07-03T00:00:00.000Z",
	databaseName: "neondb",
	tableCount: 2,
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
			schema: "analytics",
			name: "events",
			columns: [],
			primaryKeys: [],
			foreignKeys: [],
			indexes: [],
		},
	],
};

describe("neon database agent", () => {
	test("reports the neon database type", () => {
		const agent = createAgent();

		expect(agent.getDatabaseType()).toBe("neon");
	});

	test("includes Neon-specific docs-only and pooling instructions", async () => {
		const agent = createAgent();
		const instructions = await agent.getAgent().getInstructions();
		const text = Array.isArray(instructions)
			? instructions.join("\n")
			: String(instructions);

		expect(text).toContain("Neon-hosted PostgreSQL");
		expect(text).toContain("projects");
		expect(text).toContain("branches");
		expect(text).toContain("pooled connections");
		expect(text).toContain("qcp_read_neon_context");
		expect(text).toContain("SET search_path");
		expect(text).toContain("Neon MCP is docs/context-only");
		expect(text).toContain("qcp read-only database tools");
	});

	test("adds generic read-only tools plus Neon context", () => {
		const tools = createNeonTools({
			databaseUrl:
				"postgresql://reader:secret@ep-cool-darkness-123456.us-east-2.aws.neon.tech/neondb?sslmode=require",
			schema,
		});

		expect(Object.keys(tools).sort()).toEqual([
			"qcp_audit_postgres_privacy_posture",
			"qcp_execute_read_sql",
			"qcp_explain_read_sql",
			"qcp_export_database_data",
			"qcp_import_database_data",
			"qcp_read_database_context",
			"qcp_read_neon_context",
			"qcp_suggest_query_improvements",
			"qcp_validate_sql",
		]);
	});

	test("infers direct Neon endpoint context without leaking credentials", async () => {
		const tools = createNeonTools({
			databaseUrl:
				"postgresql://reader:secret@ep-cool-darkness-123456.us-east-2.aws.neon.tech/neondb?sslmode=require",
			schema,
			mcpDocsLoader: async () => ({
				enabled: false,
				status: "disabled",
				allowedTools: [],
				errors: {},
			}),
		});

		const context = (await executeTool(
			tools,
			"qcp_read_neon_context",
			{},
		)) as NeonContextOutput;
		const serialized = JSON.stringify(context);

		expect(context.host).toBe(
			"ep-cool-darkness-123456.us-east-2.aws.neon.tech",
		);
		expect(context.endpointId).toBe("ep-cool-darkness-123456");
		expect(context.regionHint).toBe("us-east-2.aws");
		expect(context.pooledConnection).toBe(false);
		expect(context.sslMode).toBe("require");
		expect(context.connectionGuidance).toContain("direct");
		expect(context.mcpGuidance).toContain("docs/context-only");
		expect(serialized).not.toContain("secret");
		expect(serialized).not.toContain("reader");
	});

	test("infers pooled Neon endpoint context and warns about session SQL", async () => {
		const tools = createNeonTools({
			databaseUrl:
				"postgres://reader:secret@ep-cool-darkness-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require",
			schema,
			mcpDocsLoader: async () => ({
				enabled: true,
				status: "available",
				allowedTools: ["get_doc_resource", "list_docs_resources"],
				errors: {},
			}),
		});

		const context = (await executeTool(
			tools,
			"qcp_read_neon_context",
			{},
		)) as NeonContextOutput;

		expect(context.pooledConnection).toBe(true);
		expect(context.endpointId).toBe("ep-cool-darkness-123456");
		expect(context.connectionGuidance).toContain("PgBouncer transaction mode");
		expect(context.connectionGuidance).toContain("SET search_path");
		expect(context.connectionGuidance).toContain("schema-qualified SQL");
		expect(context.mcpDocs.allowedTools).toEqual([
			"get_doc_resource",
			"list_docs_resources",
		]);
	});

	test("parses Neon connection URLs directly", () => {
		expect(
			inferNeonConnection(
				"postgres://u:p@ep-cool-darkness-123456-pooler.us-east-2.aws.neon.tech/db?sslmode=require",
			),
		).toEqual({
			host: "ep-cool-darkness-123456-pooler.us-east-2.aws.neon.tech",
			endpointId: "ep-cool-darkness-123456",
			regionHint: "us-east-2.aws",
			pooledConnection: true,
			sslMode: "require",
		});
	});

	test("Neon MCP docs helper is disabled without an API key", async () => {
		const originalApiKey = process.env.NEON_API_KEY;
		delete process.env.NEON_API_KEY;

		try {
			const context = await loadNeonMcpDocsContext(async () => {
				throw new Error("should not create client without key");
			});

			expect(context).toEqual({
				enabled: false,
				status: "disabled",
				allowedTools: [],
				errors: {},
			});
		} finally {
			restoreEnv("NEON_API_KEY", originalApiKey);
		}
	});

	test("Neon MCP docs helper keeps only allowlisted docs tools", async () => {
		const originalApiKey = process.env.NEON_API_KEY;
		process.env.NEON_API_KEY = "test-key";

		try {
			const context = await loadNeonMcpDocsContext(async () => ({
				async listToolsWithErrors() {
					return {
						tools: {
							"neon.list_docs_resources": mockTool(),
							neon_get_doc_resource: mockTool(),
							"neon.run_sql": mockTool(),
							"neon.create_branch": mockTool(),
						},
						errors: {},
					};
				},
				async disconnect() {},
			}));

			expect(context.enabled).toBe(true);
			expect(context.status).toBe("available");
			expect(context.allowedTools).toEqual([
				"get_doc_resource",
				"list_docs_resources",
			]);
		} finally {
			restoreEnv("NEON_API_KEY", originalApiKey);
		}
	});

	test("Neon MCP docs helper degrades cleanly on client failure", async () => {
		const originalApiKey = process.env.NEON_API_KEY;
		process.env.NEON_API_KEY = "test-key";

		try {
			const context = await loadNeonMcpDocsContext(async () =>
				failingMcpClient("startup failed"),
			);

			expect(context.enabled).toBe(true);
			expect(context.status).toBe("unavailable");
			expect(context.allowedTools).toEqual([]);
			expect(context.errors.neon).toContain("startup failed");
		} finally {
			restoreEnv("NEON_API_KEY", originalApiKey);
		}
	});
});

interface NeonContextOutput {
	readonly host?: string;
	readonly endpointId?: string;
	readonly regionHint?: string;
	readonly pooledConnection?: boolean;
	readonly sslMode?: string;
	readonly connectionGuidance: string;
	readonly mcpGuidance: string;
	readonly mcpDocs: {
		readonly allowedTools: readonly string[];
	};
}

function createAgent(): NeonAgent<"qcp-neon-agent"> {
	const config = configWithDatabaseType("neon");

	return new NeonAgent({
		id: "qcp-neon-agent",
		name: "QCP Neon Database Agent",
		description:
			"Answers questions about Neon-hosted PostgreSQL databases using qcp read-only database tools.",
		model: createMastraModelConfig(config),
		databaseUrl:
			"postgresql://reader:secret@ep-cool-darkness-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require",
		schema,
		mcpDocsLoader: async () => ({
			enabled: false,
			status: "disabled",
			allowedTools: [],
			errors: {},
		}),
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

function mockTool(): ToolAction<unknown, unknown, unknown, unknown> {
	return {} as ToolAction<unknown, unknown, unknown, unknown>;
}

function failingMcpClient(message: string): NeonMcpDocsClient {
	return {
		async listToolsWithErrors() {
			throw new Error(message);
		},
		async disconnect() {},
	};
}

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		return;
	}

	process.env[key] = value;
}

function configWithDatabaseType(
	databaseType: QcpConfig["databaseType"],
): QcpConfig {
	return {
		version: "0.1.0",
		installId: "019a0000-0000-7000-8000-000000000000",
		databaseConnections: [],
		databaseType,
		provider: "gemini",
		model: "gemini-2.5-flash",
		telemetry: true,
		safetyLevel: "standard",
		safeMode: true,
		showSql: true,
		showMetrics: false,
		sensitiveTablePatterns: [],
		apiKeys: {},
	};
}
