import type { DatabaseAgentType } from "./database-agent.js";
import { PostgresAgent, type PostgresAgentConfig } from "./postgres-agent.js";

export interface NeonAgentConfig<TAgentId extends string = string>
	extends PostgresAgentConfig<TAgentId> {
	readonly projectId?: string;
	readonly branchName?: string;
	readonly pooledConnection?: boolean;
}

export class NeonAgent<
	TAgentId extends string = string,
> extends PostgresAgent<TAgentId> {
	protected readonly neonConfig: NeonAgentConfig<TAgentId>;

	public constructor(config: NeonAgentConfig<TAgentId>) {
		super(config);
		this.neonConfig = config;
	}

	public override getDatabaseType(): DatabaseAgentType {
		return "neon";
	}

	protected override getPostgresProviderInstructions(): string[] {
		return [
			"Treat the database as a Neon-hosted PostgreSQL database.",
			"Account for Neon concepts such as projects, branches, pooled connections, and serverless connection behavior when relevant.",
			"Prefer short-lived, efficient queries because serverless PostgreSQL connections may be pooled or cold-started.",
			...this.getNeonContextInstructions(),
		];
	}

	protected getNeonContextInstructions(): string[] {
		return [
			this.neonConfig.projectId
				? `Neon project id: ${this.neonConfig.projectId}.`
				: "",
			this.neonConfig.branchName
				? `Neon branch name: ${this.neonConfig.branchName}.`
				: "",
			typeof this.neonConfig.pooledConnection === "boolean"
				? `Neon pooled connection enabled: ${this.neonConfig.pooledConnection}.`
				: "",
		].filter((instruction) => instruction.length > 0);
	}
}
