import type { DatabaseAgentType } from "./database-agent.js";
import { PostgresAgent, type PostgresAgentConfig } from "./postgres-agent.js";

export interface OraclePostgresAgentConfig<TAgentId extends string = string>
	extends PostgresAgentConfig<TAgentId> {
	readonly serviceName?: string;
	readonly region?: string;
}

export class OraclePostgresAgent<
	TAgentId extends string = string,
> extends PostgresAgent<TAgentId> {
	protected readonly oraclePostgresConfig: OraclePostgresAgentConfig<TAgentId>;

	public constructor(config: OraclePostgresAgentConfig<TAgentId>) {
		super(config);
		this.oraclePostgresConfig = config;
	}

	public override getDatabaseType(): DatabaseAgentType {
		return "oracle-postgres";
	}

	protected override getPostgresProviderInstructions(): string[] {
		return [
			"Treat the database as a PostgreSQL-compatible database hosted on Oracle infrastructure.",
			"Prefer standard PostgreSQL syntax unless a concrete subclass or tool documents provider-specific differences.",
			"Be explicit about compatibility assumptions when using PostgreSQL features that may vary across managed database providers.",
			...this.getOraclePostgresContextInstructions(),
		];
	}

	protected getOraclePostgresContextInstructions(): string[] {
		return [
			this.oraclePostgresConfig.serviceName
				? `Oracle PostgreSQL service name: ${this.oraclePostgresConfig.serviceName}.`
				: "",
			this.oraclePostgresConfig.region
				? `Oracle PostgreSQL region: ${this.oraclePostgresConfig.region}.`
				: "",
		].filter((instruction) => instruction.length > 0);
	}
}
