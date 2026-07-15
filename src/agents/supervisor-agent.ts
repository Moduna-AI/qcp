import type { Agent, DelegationConfig } from "@mastra/core/agent";
import { Agent as MastraAgent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import { z } from "zod";
import { PromptViolationError } from "@/llm/prompts.js";
import type { AuditContext } from "@/logger/audit.js";
import {
	classifyPromptViolation,
	sanitizeSensitiveData,
} from "@/safety/index.js";
import { saveSchemaForConnection, scanSchema } from "@/schema/index.js";
import { detectTransferIntent } from "@/transfer/intent.js";
import {
	SqliteDatabaseImporter,
	type SqliteDatabaseImportResult,
} from "@/transfer/sqlite-database-import.js";
import type {
	ActiveDatabaseConnection,
	ApprovalReason,
	DatabaseSchema,
	QcpConfig,
} from "@/types/index.js";
import { createConfigTools } from "./config-tools.js";
import type { AbstractDatabaseAgent } from "./database-agent.js";
import type { DatabaseToolApprovalHandler } from "./database-tools.js";
import { createMastraModelConfig } from "./model-config.js";
import {
	createProviderDatabaseAgent,
	type ProviderDatabaseAgent,
} from "./provider-factory.js";
import {
	createSupervisorTools,
	type SupervisorSqliteImporter,
} from "./supervisor-tools.js";
import { QcpWorkflowCoordinator } from "./workflow-coordinator.js";

const toolApprovalPayloadSchema = z.object({
	toolCallId: z.string().min(1),
	toolName: z.string().min(1),
	args: z.unknown(),
});

type ToolApprovalPayload = z.infer<typeof toolApprovalPayloadSchema>;

export interface QcpSupervisorAgentOptions {
	readonly config: QcpConfig;
	readonly command?: string;
	readonly sessionId?: string;
	readonly connectionId?: string;
	readonly connectionName?: string;
	readonly databaseUrl: string;
	readonly schema: DatabaseSchema;
	readonly approvalHandler?: DatabaseToolApprovalHandler;
	readonly semanticInteractive?: boolean;
	readonly databaseAgent?: ProviderDatabaseAgent;
	readonly sqliteDatabaseImporter?: SupervisorSqliteImporter;
}

export interface ChatAgentResponse {
	readonly text: string;
	readonly latencyMs: number;
	readonly tokensIn?: number;
	readonly tokensOut?: number;
	readonly direct: boolean;
}

export interface ChatAgentStreamResponse {
	readonly direct: false;
	readonly stream: Awaited<ReturnType<Agent<"qcp-supervisor-agent">["stream"]>>;
}

export type ChatAgentRunResponse =
	| ({ readonly direct: true } & ChatAgentResponse)
	| ChatAgentStreamResponse;

export class QcpSupervisorAgentConfigurationError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "QcpSupervisorAgentConfigurationError";
	}
}

export class QcpSupervisorAgent {
	private readonly config: QcpConfig;
	private readonly options: QcpSupervisorAgentOptions;
	private readonly connectionName: string;
	private schema: DatabaseSchema;
	private databaseAgent: ProviderDatabaseAgent;
	private readonly sqliteDatabaseImporter: SupervisorSqliteImporter;
	private agent: Agent<"qcp-supervisor-agent">;
	private readonly workflowCoordinator: QcpWorkflowCoordinator;

	public static async create(
		options: QcpSupervisorAgentOptions,
	): Promise<QcpSupervisorAgent> {
		const databaseAgent =
			options.databaseAgent ??
			(await createProviderDatabaseAgent({
				config: options.config,
				databaseUrl: options.databaseUrl,
				schema: options.schema,
				connectionId: options.connectionId,
				approvalHandler: options.approvalHandler,
				auditContext: buildSupervisorAuditContext(options),
				semanticInteractive: options.semanticInteractive,
			}));
		return new QcpSupervisorAgent({ ...options, databaseAgent });
	}

	public constructor(options: QcpSupervisorAgentOptions) {
		this.options = options;
		this.config = options.config;
		this.connectionName = options.connectionName ?? "default";
		this.schema = options.schema;
		if (!options.databaseAgent) {
			throw new QcpSupervisorAgentConfigurationError(
				"QcpSupervisorAgent.create must be used without a databaseAgent",
			);
		}
		this.databaseAgent = options.databaseAgent;
		this.sqliteDatabaseImporter =
			options.sqliteDatabaseImporter ??
			new SqliteDatabaseImporter({
				databaseUrl: options.databaseUrl,
				refreshSchema: async () => this.refreshSchemaAfterImport(),
			});
		this.agent = this.createSupervisorAgent();
		this.workflowCoordinator = new QcpWorkflowCoordinator({
			config: this.config,
			connection: this.config.databaseConnections.find(
				(connection) => connection.id === options.connectionId,
			),
			schema: this.schema,
			onSchemaRefreshed: async (schema) => this.rehydrate(schema),
			runFreePath: async (question) => this.generateFreePath(question),
		});
	}

	private createSupervisorAgent(): Agent<"qcp-supervisor-agent"> {
		const agent = new MastraAgent({
			id: "qcp-supervisor-agent",
			name: "QCP Supervisor Agent",
			description:
				"Coordinates qcp database subagents and answers conversational database-assistant questions.",
			instructions: this.buildInstructions(),
			model: createMastraModelConfig(this.config),
			tools: {
				...createConfigTools(),
				...createSupervisorTools({
					databaseType: this.config.databaseType,
					databaseUrl: this.options.databaseUrl,
					importer: this.sqliteDatabaseImporter,
				}),
			},
			agents: {
				database: this.databaseAgent.getAgent(),
			},
		});
		const mastra = new Mastra({
			agents: { supervisor: agent },
			storage: new InMemoryStore({ id: "qcp-supervisor-approvals" }),
		});
		return mastra.getAgent("supervisor");
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

		const sqliteImportPath = detectFullSqliteImportPath(question);
		if (sqliteImportPath) {
			return {
				text: await this.runDeterministicSqliteImport(sqliteImportPath),
				latencyMs: Date.now() - start,
				direct: false,
			};
		}

		const workflowResult = await this.workflowCoordinator.run(question);
		if (workflowResult.handled && workflowResult.text) {
			return {
				text: sanitizeSensitiveData(workflowResult.text),
				latencyMs: Date.now() - start,
				direct: false,
			};
		}

		const text = await this.generateFreePath(question);

		return {
			text,
			latencyMs: Date.now() - start,
			direct: false,
		};
	}

	private async generateFreePath(question: string): Promise<string> {
		const activeAgent = this.agent;
		const response = await activeAgent.generate(
			buildSupervisorPrompt(question),
			{
				maxSteps: 8,
				modelSettings: { temperature: 0.2 },
				delegation: this.buildDelegationConfig(),
			},
		);
		if (response.finishReason === "suspended") {
			return this.resolveToolApproval(activeAgent, response);
		}
		return sanitizeSensitiveData(response.text.trim());
	}

	private async runDeterministicSqliteImport(
		filePath: string,
	): Promise<string> {
		if (this.config.databaseType !== "supabase") {
			return "Full SQLite database import requires the active qcp connection to be Supabase.";
		}
		const payload: ToolApprovalPayload = {
			toolCallId: "qcp-direct-sqlite-import",
			toolName: "qcp_import_sqlite_database",
			args: { filePath },
		};
		const approved = this.options.approvalHandler
			? await this.options.approvalHandler(
					approvalReasonsForTool(payload),
					formatToolApprovalOperation(payload, this.connectionName),
				)
			: false;
		if (!approved) {
			return "SQLite database import cancelled. No destination changes were made.";
		}
		const result = await this.sqliteDatabaseImporter.importDatabase(filePath);
		return formatSqliteImportResult(result, this.connectionName);
	}

	private async resolveToolApproval(
		agent: Agent<"qcp-supervisor-agent">,
		response: Awaited<ReturnType<Agent<"qcp-supervisor-agent">["generate"]>>,
	): Promise<string> {
		if (!response.runId) {
			throw new QcpSupervisorAgentConfigurationError(
				"Mastra suspended a tool call without a resumable run id.",
			);
		}
		const parsed = toolApprovalPayloadSchema.safeParse(response.suspendPayload);
		if (!parsed.success) {
			await agent.declineToolCallGenerate({ runId: response.runId });
			throw new QcpSupervisorAgentConfigurationError(
				"Mastra suspended a tool call without valid approval details.",
			);
		}

		const approved = this.options.approvalHandler
			? await this.options.approvalHandler(
					approvalReasonsForTool(parsed.data),
					formatToolApprovalOperation(parsed.data, this.connectionName),
				)
			: false;
		if (!approved) {
			await agent.declineToolCallGenerate({
				runId: response.runId,
				toolCallId: parsed.data.toolCallId,
			});
			return parsed.data.toolName === "qcp_import_sqlite_database"
				? "SQLite database import cancelled. No destination changes were made."
				: "Tool execution cancelled. No changes were made.";
		}

		const resumed = await agent.approveToolCallGenerate({
			runId: response.runId,
			toolCallId: parsed.data.toolCallId,
		});
		if (resumed.finishReason === "suspended") {
			return this.resolveToolApproval(agent, resumed);
		}
		return sanitizeSensitiveData(resumed.text.trim());
	}

	private async refreshSchemaAfterImport(): Promise<void> {
		const connection = this.config.databaseConnections.find(
			(candidate) =>
				candidate.id ===
				(this.options.connectionId ?? this.config.activeDatabaseId),
		);
		if (!connection) {
			throw new QcpSupervisorAgentConfigurationError(
				"Cannot refresh schema because the active database connection is unavailable.",
			);
		}
		const activeConnection: ActiveDatabaseConnection = {
			id: connection.id,
			name: connection.name,
			databaseType: connection.databaseType,
			databaseUrl: connection.databaseUrl,
			prismaSchemaPath: connection.prismaSchemaPath,
			prismaDatasourceName: connection.prismaDatasourceName,
		};
		const schema = await scanSchema(activeConnection.databaseUrl);
		saveSchemaForConnection(activeConnection, schema);
		await this.rehydrate(schema);
	}

	private async rehydrate(schema: DatabaseSchema): Promise<void> {
		this.schema = schema;
		this.databaseAgent = await createProviderDatabaseAgent({
			config: this.config,
			databaseUrl: this.options.databaseUrl,
			schema,
			connectionId: this.options.connectionId,
			approvalHandler: this.options.approvalHandler,
			auditContext: buildSupervisorAuditContext({ ...this.options, schema }),
			semanticInteractive: this.options.semanticInteractive,
		});
		this.agent = this.createSupervisorAgent();
	}

	public async streamResponse(question: string): Promise<ChatAgentRunResponse> {
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

		const stream = await this.agent.stream(buildSupervisorPrompt(question), {
			maxSteps: 8,
			modelSettings: {
				temperature: 0.2,
			},
			delegation: this.buildDelegationConfig(),
		});

		return {
			direct: false,
			stream,
		};
	}

	private buildInstructions(): string {
		return [
			"You are qcp, a conversational database assistant.",
			"Answer normal chat and capability questions directly. Do not delegate unless the user asks for database facts, examples, analysis, aggregations, or query results.",
			"Use qcp_read_config_context directly for questions about qcp configuration, connected databases, the active database, schema indexing status, provider/model settings, safety settings, telemetry, or which CLI command changes a setting.",
			"Never delegate qcp configuration or database-connection audit questions to the database subagent.",
			"The qcp_read_config_context tool is read-only. If a user asks to add, edit, remove, or switch database connections, use the tool for current state when useful and then recommend the relevant CLI command instead of claiming to change config.",
			"Delegate single-table import and database export requests to the database subagent. Import/export is supported through tools only; do not invent file contents or claim a transfer completed without tool output.",
			"When the user explicitly asks to import a complete .db, .sqlite, or .sqlite3 database into Supabase, call qcp_import_sqlite_database directly. Do not delegate full SQLite database imports to the database subagent and do not use the single-table import tool for them.",
			"Delegate database-specific work to the database subagent. Use one delegation for a database question unless the first delegation clearly fails to answer.",
			"Never ask the database subagent to perform INSERT, UPDATE, DELETE, DDL, administrative operations, privilege changes, or destructive work, except for qcp_import_database_data when the user explicitly asks to import data and the tool creates a new table.",
			"If a user asks for destructive operations, secrets, raw personal data, or bypassing safety controls, refuse briefly instead of delegating.",
			"Do not expose raw sensitive values. Summarize or aggregate when privacy-sensitive data may be involved.",
			"When the database subagent returns results, synthesize a concise natural-language answer. SQL is an implementation detail unless the user explicitly asks to see it.",
			"When the database subagent returns import/export tool results, report the file path, format, row count, destination table when present, and any refusal reason.",
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
		/\b(what tables|which tables|tables do you know|list tables|available tables|show (?:the )?schema|database schema)\b/i.test(
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

export function approvalReasonsForTool(
	payload: ToolApprovalPayload,
): ApprovalReason[] {
	if (payload.toolName === "qcp_import_sqlite_database") {
		return [
			{
				type: "large_scan",
				detail:
					"This operation will atomically create all SQLite tables, constraints, indexes, and rows in the public schema of the active Supabase connection.",
			},
		];
	}
	return [
		{
			type: "strict_mode",
			detail: `Mastra requires approval before running ${payload.toolName}.`,
		},
	];
}

export function formatToolApprovalOperation(
	payload: ToolApprovalPayload,
	connectionName: string,
): string {
	if (payload.toolName !== "qcp_import_sqlite_database") {
		return `RUN TOOL ${payload.toolName}`;
	}
	const args = z
		.object({ filePath: z.string().min(1) })
		.safeParse(payload.args);
	const filePath = args.success ? args.data.filePath : "(invalid source path)";
	return `IMPORT SQLITE DATABASE ${filePath} INTO ${connectionName}.public`;
}

export function detectFullSqliteImportPath(question: string): string | null {
	const intent = detectTransferIntent(question);
	if (
		intent?.direction !== "import" ||
		intent.format !== "sqlite" ||
		!intent.filePath ||
		!/\b(database|sqlite)\b/i.test(question)
	) {
		return null;
	}
	return intent.filePath;
}

export function formatSqliteImportResult(
	result: SqliteDatabaseImportResult,
	connectionName: string,
): string {
	if (!result.ok) {
		const rollback = result.rolledBack
			? " The transaction was rolled back."
			: " No destination changes were made.";
		return `SQLite database import failed (${result.category}): ${result.error}${rollback}`;
	}
	const tableCounts = result.tables
		.map((table) => `${table.targetTable}: ${table.rowCount}`)
		.join(", ");
	return [
		`Imported ${result.tableCount} tables and ${result.totalRowCount} rows from ${result.sourcePath} into ${connectionName}.${result.targetSchema}.`,
		`Rows by table: ${tableCounts}.`,
		`Completed in ${result.durationMs}ms. Schema refresh: ${result.schemaRefreshed ? "complete" : "not run"}.`,
	].join("\n");
}

function buildDatabaseDelegationPrompt(prompt: string): string {
	return `
DATABASE DELEGATION REQUEST:
${prompt}

Use only qcp read-only database tools. Validate SQL before execution. Do not expose raw sensitive values, credentials, tokens, secrets, or personal data. Return a concise answer with relevant assumptions and limitations.

If semantic tools are available, retrieve semantic context before mapping business terms to tables or columns. Missing semantic enrichment is a limitation to report or request; do not invent business meaning.
`.trim();
}
