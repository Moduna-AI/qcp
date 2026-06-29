import type { Agent } from "@mastra/core/agent";
import { Agent as MastraAgent } from "@mastra/core/agent";
import { sanitizeSensitiveData } from "@/safety/index.js";
import type { DatabaseSchema, QcpConfig } from "@/types/index.js";
import type { AbstractDatabaseAgent } from "./database-agent.js";
import type { DatabaseToolApprovalHandler } from "./database-tools.js";
import { createMastraModelConfig } from "./model-config.js";
import {
	createProviderDatabaseAgent,
	type ProviderDatabaseAgent,
} from "./provider-factory.js";

export interface QcpSupervisorAgentOptions {
	readonly config: QcpConfig;
	readonly databaseUrl: string;
	readonly schema: DatabaseSchema;
	readonly approvalHandler?: DatabaseToolApprovalHandler;
	readonly databaseAgent?: ProviderDatabaseAgent;
}

export interface ChatAgentResponse {
	readonly text: string;
	readonly latencyMs: number;
	readonly tokensIn?: number;
	readonly tokensOut?: number;
	readonly direct: boolean;
}

export class QcpSupervisorAgent {
	private readonly config: QcpConfig;
	private readonly schema: DatabaseSchema;
	private readonly databaseAgent: ProviderDatabaseAgent;
	private readonly agent: Agent<"qcp-supervisor-agent">;

	public constructor(options: QcpSupervisorAgentOptions) {
		this.config = options.config;
		this.schema = options.schema;
		this.databaseAgent =
			options.databaseAgent ??
			createProviderDatabaseAgent({
				config: options.config,
				databaseUrl: options.databaseUrl,
				schema: options.schema,
				approvalHandler: options.approvalHandler,
			});
		this.agent = new MastraAgent({
			id: "qcp-supervisor-agent",
			name: "QCP Supervisor Agent",
			description:
				"Coordinates qcp database subagents and answers conversational database-assistant questions.",
			instructions: this.buildInstructions(),
			model: createMastraModelConfig(options.config),
			agents: {
				database: this.databaseAgent.getAgent(),
			},
		});
	}

	public getAgent(): Agent<"qcp-supervisor-agent"> {
		return this.agent;
	}

	public getDatabaseAgent(): ProviderDatabaseAgent {
		return this.databaseAgent;
	}

	public getSubAgents(): Record<string, AbstractDatabaseAgent> {
		return {
			database: this.databaseAgent,
		};
	}

	public async generateResponse(question: string): Promise<ChatAgentResponse> {
		const start = Date.now();
		const directAnswer = getDirectChatAnswer(question, this.schema);
		if (directAnswer) {
			return {
				text: directAnswer,
				latencyMs: Date.now() - start,
				direct: true,
			};
		}

		const response = await this.agent.generate(
			buildSupervisorPrompt(question),
			{
				maxSteps: 8,
				modelSettings: {
					temperature: 0.2,
				},
				delegation: {
					includeSubAgentToolResultsInModelContext: false,
				},
			},
		);

		return {
			text: sanitizeSensitiveData(response.text.trim()),
			tokensIn: response.usage?.inputTokens,
			tokensOut: response.usage?.outputTokens,
			latencyMs: Date.now() - start,
			direct: false,
		};
	}

	private buildInstructions(): string {
		return [
			"You are qcp, a conversational database assistant.",
			"Answer normal chat and capability questions directly. Do not generate SQL unless the user asks for database facts, examples, analysis, aggregations, or query results.",
			"Delegate database-specific work to the database subagent. The database subagent has qcp read-only tools for schema context, SQL validation, EXPLAIN, and safe read-only execution.",
			"Never ask the database subagent to perform INSERT, UPDATE, DELETE, DDL, administrative operations, privilege changes, or destructive work.",
			"Do not expose raw sensitive values. Summarize or aggregate when privacy-sensitive data may be involved.",
			"When the database subagent returns results, synthesize a concise natural-language answer. SQL is an implementation detail unless the user explicitly asks to see it.",
			`Configured database type: ${this.config.databaseType}.`,
			`Loaded schema: ${this.schema.databaseName} with ${this.schema.tableCount} tables.`,
		].join("\n\n");
	}
}

export function getDirectChatAnswer(
	question: string,
	schema: DatabaseSchema,
): string | null {
	const normalized = question.trim().toLowerCase();
	if (!normalized) return null;

	if (
		/\b(what can you help|what do you do|help me with|capabilities|how can you help)\b/i.test(
			normalized,
		)
	) {
		return [
			"I can help you understand and explore this database in plain English.",
			"",
			`I have schema context for ${schema.databaseName} with ${schema.tableCount} tables. You can ask about available tables, relationships, metrics, trends, counts, examples, anomalies, and how to write safer questions. When a question needs live data, I can ask the database subagent to run a validated read-only query.`,
		].join("\n");
	}

	if (
		/\b(how do i ask|how should i ask|good database questions|example questions)\b/i.test(
			normalized,
		)
	) {
		return [
			"Good questions usually name the business object, timeframe, grouping, and output shape.",
			"",
			"Examples:",
			"- Which projects were created this week?",
			"- Count spans by provider over the last 7 days.",
			"- Show the top tables by estimated row count.",
			"- Explain how organizations relate to projects.",
		].join("\n");
	}

	if (
		/\b(what tables|which tables|tables do you know|list tables|available tables)\b/i.test(
			normalized,
		)
	) {
		const maxTables = 20;
		const tableNames = schema.tables
			.slice(0, maxTables)
			.map((table) =>
				table.schema === "public"
					? table.name
					: `${table.schema}.${table.name}`,
			);
		const suffix =
			schema.tableCount > maxTables
				? `\n\n...and ${schema.tableCount - maxTables} more. Use /schema for the full CLI table overview.`
				: "";

		return `I know about these tables:\n\n${tableNames.map((table) => `- ${table}`).join("\n")}${suffix}`;
	}

	return null;
}

function buildSupervisorPrompt(question: string): string {
	return `
USER MESSAGE:
${question}

Respond as qcp. If this is conversational, answer directly. If it requires database-specific facts or live data, delegate to the database subagent and synthesize the result.
`.trim();
}
