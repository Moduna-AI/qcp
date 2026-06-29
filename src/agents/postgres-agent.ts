import type {
	DatabaseAgentConfig,
	DatabaseAgentType,
} from "./database-agent.js";
import { AbstractDatabaseAgent } from "./database-agent.js";

export interface PostgresAgentConfig<TAgentId extends string = string>
	extends DatabaseAgentConfig<TAgentId> {
	readonly schemaName?: string;
}

export class PostgresAgent<
	TAgentId extends string = string,
> extends AbstractDatabaseAgent<TAgentId> {
	protected readonly postgresConfig: PostgresAgentConfig<TAgentId>;

	public constructor(config: PostgresAgentConfig<TAgentId>) {
		super(config);
		this.postgresConfig = config;
	}

	public override getDatabaseType(): DatabaseAgentType {
		return "postgres";
	}

	protected override getDatabaseInstructions(): string[] {
		return [
			"Use PostgreSQL dialect and PostgreSQL-specific metadata conventions.",
			"Prefer parameterized, bounded, read-only SQL unless a concrete subclass explicitly provides safe write tools.",
			"Use schemas explicitly when they are relevant. Default to the configured schema only when one is provided.",
			"Inspect information_schema, pg_catalog, indexes, constraints, and foreign keys when available before inferring relationships.",
			"Use EXPLAIN or estimation tools when available for potentially expensive queries.",
			...this.getPostgresProviderInstructions(),
		];
	}

	protected override getAdditionalInstructions(): string[] {
		return this.postgresConfig.schemaName
			? [`Default PostgreSQL schema: ${this.postgresConfig.schemaName}.`]
			: [];
	}

	protected getPostgresProviderInstructions(): string[] {
		return [];
	}
}
