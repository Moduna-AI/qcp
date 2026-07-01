import type { DatabaseAgentType } from "./database-agent.js";
import { PostgresAgent, type PostgresAgentConfig } from "./postgres-agent.js";

export interface SupabaseAgentConfig<TAgentId extends string = string>
	extends PostgresAgentConfig<TAgentId> {
	readonly projectUrl?: string;
	readonly projectRef?: string;
	readonly useRowLevelSecurity?: boolean;
}

export class SupabaseAgent<
	TAgentId extends string = string,
> extends PostgresAgent<TAgentId> {
	protected readonly supabaseConfig: SupabaseAgentConfig<TAgentId>;

	public constructor(config: SupabaseAgentConfig<TAgentId>) {
		super(config);
		this.supabaseConfig = config;
	}

	public override getDatabaseType(): DatabaseAgentType {
		return "supabase";
	}

	protected override getPostgresProviderInstructions(): string[] {
		return [
			"Treat the database as a Supabase-hosted PostgreSQL database.",
			"Account for Supabase conventions such as auth schemas, storage schemas, public schema usage, generated APIs, and row-level security.",
			"Do not bypass row-level security assumptions. Mention when answers may differ between service-role and end-user access.",
			...this.getSupabaseContextInstructions(),
		];
	}

	protected getSupabaseContextInstructions(): string[] {
		return [
			this.supabaseConfig.projectUrl
				? `Supabase project URL: ${this.supabaseConfig.projectUrl}.`
				: "",
			this.supabaseConfig.projectRef
				? `Supabase project ref: ${this.supabaseConfig.projectRef}.`
				: "",
			typeof this.supabaseConfig.useRowLevelSecurity === "boolean"
				? `Supabase row-level security expected: ${this.supabaseConfig.useRowLevelSecurity}.`
				: "",
		].filter((instruction) => instruction.length > 0);
	}
}
