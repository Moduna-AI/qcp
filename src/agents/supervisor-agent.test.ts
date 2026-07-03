import { describe, expect, test } from "bun:test";
import { PromptViolationError } from "@/llm/prompts.js";
import type { DatabaseSchema, QcpConfig } from "@/types/index.js";
import {
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
		safeMode: true,
		showSql: true,
		showMetrics: false,
		sensitiveTablePatterns: [],
		apiKeys: {},
	};
}
