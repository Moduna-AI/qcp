import type { DatabaseAgentType } from "./database-agent.js";
import { PostgresAgent, type PostgresAgentConfig } from "./postgres-agent.js";

export interface PrismaAgentConfig<TAgentId extends string = string>
	extends PostgresAgentConfig<TAgentId> {
	readonly prismaSchemaPath?: string;
	readonly datasourceName?: string;
}

export class PrismaAgent<
	TAgentId extends string = string,
> extends PostgresAgent<TAgentId> {
	protected readonly prismaConfig: PrismaAgentConfig<TAgentId>;

	public constructor(config: PrismaAgentConfig<TAgentId>) {
		super(config);
		this.prismaConfig = config;
	}

	public override getDatabaseType(): DatabaseAgentType {
		return "prisma";
	}

	protected override getPostgresProviderInstructions(): string[] {
		return [
			"Treat Prisma schema, models, relations, enums, and datasource metadata as the preferred application-level database context when available.",
			"Map natural-language requests to the underlying PostgreSQL schema without ignoring Prisma model names or relation names.",
			"Call out differences between Prisma model names and physical table or column names when they affect the answer.",
			...this.getPrismaContextInstructions(),
		];
	}

	protected getPrismaContextInstructions(): string[] {
		return [
			this.prismaConfig.prismaSchemaPath
				? `Prisma schema path: ${this.prismaConfig.prismaSchemaPath}.`
				: "",
			this.prismaConfig.datasourceName
				? `Prisma datasource name: ${this.prismaConfig.datasourceName}.`
				: "",
		].filter((instruction) => instruction.length > 0);
	}
}
