import { describe, expect, test } from "bun:test";
import { PromptViolationError } from "@/llm/prompts.js";
import type { DatabaseSchema, QcpConfig } from "@/types/index.js";
import { createChartTools } from "./chart-tools.js";
import {
	approvalReasonsForTool,
	detectFullSqliteImportPath,
	formatSqliteImportResult,
	formatToolApprovalOperation,
	getDirectChatAnswer,
	QcpSupervisorAgent,
	QcpSupervisorAgentConfigurationError,
} from "./supervisor-agent.js";

const schema: DatabaseSchema = {
	scannedAt: "2026-06-29T00:00:00.000Z",
	databaseName: "test",
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
			schema: "observability",
			name: "llm_spans",
			columns: [],
			primaryKeys: [],
			foreignKeys: [],
			indexes: [],
		},
	],
};

describe("qcp supervisor agent", () => {
	test("configures the selected provider database subagent", async () => {
		const supervisor = await QcpSupervisorAgent.create({
			config: configWithDatabaseType("supabase"),
			databaseUrl: "postgres://example",
			schema,
		});

		expect(supervisor.getDatabaseAgent().getDatabaseType()).toBe("supabase");
		expect(supervisor.getSubAgents().database.getDatabaseType()).toBe(
			"supabase",
		);
		expect(supervisor.getSubAgents().database.getTools()).toHaveProperty(
			"qcp_read_supabase_context",
		);
		expect(supervisor.getSubAgents().database.getTools()).toHaveProperty(
			"qcp_export_database_data",
		);
		expect(supervisor.getSubAgents().database.getTools()).toHaveProperty(
			"qcp_import_database_data",
		);
		const supervisorTools = await supervisor.getAgent().listTools();
		expect(supervisorTools).toHaveProperty("qcp_read_config_context");
		expect(supervisorTools).toHaveProperty("qcp_import_sqlite_database");
		expect(supervisor.getSubAgents().database.getTools()).not.toHaveProperty(
			"qcp_read_config_context",
		);
		expect(supervisor.getSubAgents().database.getTools()).not.toHaveProperty(
			"qcp_render_chart",
		);
	});

	test("preserves the web chart tool and one-chart instructions during rehydration", async () => {
		const supervisor = await QcpSupervisorAgent.create({
			config: configWithDatabaseType("supabase"),
			databaseUrl: "postgres://example",
			schema,
			additionalDatabaseTools: createChartTools(),
		});

		expect(supervisor.getDatabaseAgent().getTools()).toHaveProperty(
			"qcp_render_chart",
		);
		const instructions = await supervisor
			.getDatabaseAgent()
			.getAgent()
			.getInstructions();
		expect(instructions).toContain("Call qcp_render_chart at most once");

		const rehydrate = Reflect.get(supervisor, "rehydrate") as (
			nextSchema: DatabaseSchema,
		) => Promise<void>;
		await rehydrate.call(supervisor, { ...schema, scannedAt: "2026-07-15" });

		expect(supervisor.getDatabaseAgent().getTools()).toHaveProperty(
			"qcp_render_chart",
		);
	});

	test("answers capability chat without invoking a model or SQL pipeline", async () => {
		const supervisor = await QcpSupervisorAgent.create({
			config: configWithDatabaseType("other-postgres"),
			databaseUrl: "postgres://example",
			schema,
		});

		const response = await supervisor.generateResponse(
			"What can you help me with?",
		);

		expect(response.direct).toBe(true);
		expect(response.text).toContain("plain English");
		expect(response.text).toContain("read-only query");
	});

	test("rejects unsafe prompts before model or database delegation", async () => {
		const supervisor = await QcpSupervisorAgent.create({
			config: configWithDatabaseType("other-postgres"),
			databaseUrl: "postgres://example",
			schema,
		});

		await expect(
			supervisor.generateResponse("Delete all projects"),
		).rejects.toBeInstanceOf(PromptViolationError);
	});

	test("requires create when no database agent is provided", () => {
		expect(
			() =>
				new QcpSupervisorAgent({
					config: configWithDatabaseType("other-postgres"),
					databaseUrl: "postgres://example",
					schema,
				}),
		).toThrow(QcpSupervisorAgentConfigurationError);
	});

	test("summarizes known tables directly", () => {
		const answer = getDirectChatAnswer(
			"What tables do you know about?",
			schema,
		);

		expect(answer).toContain("projects");
		expect(answer).toContain("observability.llm_spans");
	});

	test("shows the cached schema directly", () => {
		const answer = getDirectChatAnswer(
			"Show schema in the chinook database.",
			schema,
		);

		expect(answer).toContain("projects");
		expect(answer).toContain("observability.llm_spans");
	});

	test("formats full database import approval without exposing a destination URL", () => {
		const payload = {
			toolCallId: "tool-1",
			toolName: "qcp_import_sqlite_database",
			args: { filePath: "./Chinook_Sqlite.sqlite" },
		};

		expect(approvalReasonsForTool(payload)[0]?.detail).toContain(
			"active Supabase connection",
		);
		expect(formatToolApprovalOperation(payload, "chinook")).toBe(
			"IMPORT SQLITE DATABASE ./Chinook_Sqlite.sqlite INTO chinook.public",
		);
		expect(formatToolApprovalOperation(payload, "chinook")).not.toContain(
			"postgres://",
		);
	});

	test("detects full SQLite database imports deterministically", () => {
		expect(
			detectFullSqliteImportPath(
				"Import ./Chinook_Sqlite.sqlite into supabase chinook database.",
			),
		).toBe("./Chinook_Sqlite.sqlite");
		expect(detectFullSqliteImportPath("Import customers.csv")).toBeNull();
	});

	test("runs a detected SQLite import with one approval and no model call", async () => {
		const approvals: string[] = [];
		const supervisor = await QcpSupervisorAgent.create({
			config: configWithDatabaseType("supabase"),
			databaseUrl: "postgres://example",
			schema,
			connectionName: "chinook",
			approvalHandler: async (_reasons, operation) => {
				approvals.push(operation);
				return true;
			},
			sqliteDatabaseImporter: {
				importDatabase: async () => ({
					ok: true,
					sourcePath: "/workspace/Chinook_Sqlite.sqlite",
					targetSchema: "public",
					tableCount: 11,
					totalRowCount: 15_607,
					tables: [
						{ sourceTable: "Artist", targetTable: "artist", rowCount: 275 },
					],
					durationMs: 10,
					schemaRefreshed: true,
				}),
			},
		});

		const response = await supervisor.generateResponse(
			"Import ./Chinook_Sqlite.sqlite into supabase chinook database.",
		);

		expect(approvals).toEqual([
			"IMPORT SQLITE DATABASE ./Chinook_Sqlite.sqlite INTO chinook.public",
		]);
		expect(response.text).toContain("11 tables and 15607 rows");
		expect(response.text).toContain("artist: 275");
	});

	test("formats rolled-back SQLite failures", () => {
		expect(
			formatSqliteImportResult(
				{
					ok: false,
					category: "destination_conflict",
					error: "artist already exists",
					rolledBack: true,
				},
				"chinook",
			),
		).toContain("transaction was rolled back");
	});
});

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
