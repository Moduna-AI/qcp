import type { AgentConfig, ToolsInput } from "@mastra/core/agent";
import { Agent } from "@mastra/core/agent";

export type DatabaseAgentType =
	| "database"
	| "postgres"
	| "prisma"
	| "supabase"
	| "neon"
	| "oracle-postgres"
	| (string & {});

export interface DatabaseAgentConfig<TAgentId extends string = string> {
	id: TAgentId;
	name: string;
	description: string;
	model: AgentConfig<TAgentId, ToolsInput>["model"];
	instructions?: string | string[];
	tools?: ToolsInput;
}

export abstract class AbstractDatabaseAgent<TAgentId extends string = string> {
	protected readonly config: DatabaseAgentConfig<TAgentId>;
	private tools: ToolsInput;
	private agent: Agent<TAgentId, ToolsInput> | null;

	protected constructor(config: DatabaseAgentConfig<TAgentId>) {
		this.config = config;
		this.tools = config.tools ?? {};
		this.agent = null;
	}

	public getAgent(): Agent<TAgentId, ToolsInput> {
		if (!this.agent) {
			this.agent = this.createAgent();
		}

		return this.agent;
	}

	public getTools(): ToolsInput {
		return { ...this.tools };
	}

	public addTools(tools: ToolsInput): void {
		this.tools = {
			...this.tools,
			...tools,
		};
		this.agent = null;
	}

	public getId(): TAgentId {
		return this.config.id;
	}

	public getName(): string {
		return this.config.name;
	}

	public getDescription(): string {
		return this.config.description;
	}

	public abstract getDatabaseType(): DatabaseAgentType;

	protected abstract getDatabaseInstructions(): string | string[];

	protected getBaseInstructions(): string[] {
		return [
			"You are a database agent that helps users interact with databases using natural language.",
			"Translate user requests into accurate database operations only when enough schema and context are available.",
			"Prefer read-only exploration by default. Do not perform destructive or data-changing operations unless an explicitly provided tool and user instruction allow it.",
			"Use available schema, metadata, and query tools before guessing table names, columns, relationships, or database capabilities.",
			"When qcp_read_semantic_context is available, use it before writing SQL for business-language questions. Treat semantic context as advisory meaning only; validate and execute SQL against the actual database schema tools.",
			"If semantic context reports missing enrichment, ask for enrichment with qcp_request_schema_enrichment when interactive tools are available, or state the missing meaning instead of inventing business definitions.",
			"When producing SQL, explain the intent clearly and keep queries scoped, efficient, and safe.",
			"When a user asks why a query is slow, how to optimize SQL, or whether indexes would help, use qcp_suggest_query_improvements when available instead of guessing from schema alone.",
			"Treat performance suggestion DDL as advisory text only. Do not execute CREATE INDEX, migrations, administrative SQL, or other data-changing operations.",
			"When summarizing results, answer the user directly and call out relevant assumptions, empty results, or limitations.",
		];
	}

	protected getAdditionalInstructions(): string[] {
		return [];
	}

	protected buildInstructions(): string {
		return [
			...this.getBaseInstructions(),
			`Database type: ${this.getDatabaseType()}.`,
			...this.toInstructionList(this.getDatabaseInstructions()),
			...this.toInstructionList(this.config.instructions ?? []),
			...this.getAdditionalInstructions(),
		].join("\n\n");
	}

	protected createAgent(): Agent<TAgentId, ToolsInput> {
		return new Agent<TAgentId, ToolsInput>({
			id: this.config.id,
			name: this.config.name,
			description: this.config.description,
			instructions: this.buildInstructions(),
			model: this.config.model,
			tools: this.tools,
		});
	}

	private toInstructionList(instructions: string | string[]): string[] {
		return Array.isArray(instructions) ? instructions : [instructions];
	}
}
