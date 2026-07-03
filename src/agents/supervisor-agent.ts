import type { Agent, DelegationConfig } from "@mastra/core/agent";
import { Agent as MastraAgent } from "@mastra/core/agent";
import { PromptViolationError } from "@/llm/prompts.js";
import type { AuditContext } from "@/logger/audit.js";
import {
	classifyPromptViolation,
	sanitizeSensitiveData,
} from "@/safety/index.js";
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
	readonly command?: string;
	readonly sessionId?: string;
	readonly connectionId?: string;
	readonly connectionName?: string;
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

export class QcpSupervisorAgentConfigurationError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "QcpSupervisorAgentConfigurationError";
	}
}

export class QcpSupervisorAgent {
	private readonly config: QcpConfig;
	private readonly connectionName: string;
	private readonly schema: DatabaseSchema;
	private readonly databaseAgent: ProviderDatabaseAgent;
	private readonly agent: Agent<"qcp-supervisor-agent">;

	public static async create(
		options: QcpSupervisorAgentOptions,
	): Promise<QcpSupervisorAgent> {
		const databaseAgent =
			options.databaseAgent ??
			(await createProviderDatabaseAgent({
				config: options.config,
				databaseUrl: options.databaseUrl,
				schema: options.schema,
				approvalHandler: options.approvalHandler,
				auditContext: buildSupervisorAuditContext(options),
			}));
		return new QcpSupervisorAgent({ ...options, databaseAgent });
	}

	public constructor(options: QcpSupervisorAgentOptions) {
		this.config = options.config;
		this.connectionName = options.connectionName ?? "default";
		this.schema = options.schema;
		if (!options.databaseAgent) {
			throw new QcpSupervisorAgentConfigurationError(
				"QcpSupervisorAgent.create must be used without a databaseAgent",
			);
		}
		this.databaseAgent = options.databaseAgent;
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
		const promptViolation = classifyPromptViolation(question);
		if (promptViolation) {
			throw new PromptViolationError(promptViolation);
		}

		const directAnswer = getDirectChatAnswer(
			question,
			this.schema,
			this.connectionName,
		);
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
				delegation: this.buildDelegationConfig(),
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
			"Answer normal chat and capability questions directly. Do not delegate unless the user asks for database facts, examples, analysis, aggregations, or query results.",
			"Delegate database-specific work to the database subagent. Use one delegation for a database question unless the first delegation clearly fails to answer.",
			"Never ask the database subagent to perform INSERT, UPDATE, DELETE, DDL, administrative operations, privilege changes, or destructive work.",
			"If a user asks for destructive operations, secrets, raw personal data, or bypassing safety controls, refuse briefly instead of delegating.",
			"Do not expose raw sensitive values. Summarize or aggregate when privacy-sensitive data may be involved.",
			"When the database subagent returns results, synthesize a concise natural-language answer. SQL is an implementation detail unless the user explicitly asks to see it.",
			`Active database connection: ${this.connectionName}.`,
			`Configured database type: ${this.config.databaseType}.`,
			`Loaded schema: ${this.schema.databaseName} with ${this.schema.tableCount} tables.`,
			"To work with another configured database, tell the user to run qcp db use <alias> before starting ask or chat.",
		].join("\n\n");
	}

	private buildDelegationConfig(): DelegationConfig {
		return {
			includeSubAgentToolResultsInModelContext: false,
			onDelegationStart: ({ primitiveType, prompt }) => {
				if (primitiveType !== "agent") {
					return {
						proceed: false,
						rejectionReason:
							"qcp can only delegate database questions to database agents.",
					};
				}

				const promptViolation = classifyPromptViolation(prompt);
				if (promptViolation) {
					return {
						proceed: false,
						rejectionReason: promptViolation.detail,
					};
				}

				return {
					proceed: true,
					modifiedPrompt: buildDatabaseDelegationPrompt(prompt),
					modifiedMaxSteps: 4,
				};
			},
			onDelegationComplete: ({ error, success }) => {
				if (success && !error) return;

				return {
					feedback:
						"The database subagent could not complete the request. Answer with the failure reason and suggest a narrower read-only question if useful.",
				};
			},
			messageFilter: ({ messages }) => messages.slice(-6),
		};
	}
}

function buildSupervisorAuditContext(
	options: QcpSupervisorAgentOptions,
): AuditContext {
	return {
		command: options.command,
		sessionId: options.sessionId,
		installId: options.config.installId,
		connectionId: options.connectionId,
		connectionName: options.connectionName,
		databaseType: options.config.databaseType,
		databaseName: options.schema.databaseName,
		provider: options.config.provider,
		model: options.config.model,
	};
}

export function getDirectChatAnswer(
	question: string,
	schema: DatabaseSchema,
	connectionName = "default",
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
			`I have schema context for ${connectionName} (${schema.databaseName}) with ${schema.tableCount} tables. You can ask about available tables, relationships, metrics, trends, counts, examples, anomalies, and how to write safer questions. When a question needs live data, I can ask the database subagent to run a validated read-only query. Use qcp db use <alias> to switch databases before asking.`,
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

function buildDatabaseDelegationPrompt(prompt: string): string {
	return `
DATABASE DELEGATION REQUEST:
${prompt}

Use only qcp read-only database tools. Validate SQL before execution. Do not expose raw sensitive values, credentials, tokens, secrets, or personal data. Return a concise answer with relevant assumptions and limitations.
`.trim();
}
