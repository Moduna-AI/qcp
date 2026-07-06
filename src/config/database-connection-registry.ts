import { v7 as uuidv7 } from "uuid";
import type {
	ActiveDatabaseConnection,
	AmazonMarketingCloudConnectionConfig,
	DatabaseConnectionConfig,
	DatabaseType,
	QcpConfig,
} from "@/types/index.js";

export interface UpsertDatabaseConnectionInput {
	readonly name: string;
	readonly databaseType: DatabaseType;
	readonly databaseUrl: string;
	readonly prismaSchemaPath?: string;
	readonly prismaDatasourceName?: string;
	readonly amazonMarketingCloud?: AmazonMarketingCloudConnectionConfig;
}

export interface UpdateDatabaseConnectionInput {
	readonly name?: string;
	readonly databaseType?: DatabaseType;
	readonly databaseUrl?: string;
	readonly prismaSchemaPath?: string;
	readonly prismaDatasourceName?: string;
	readonly amazonMarketingCloud?: AmazonMarketingCloudConnectionConfig;
}

export interface DatabaseConnectionRegistrySnapshot {
	readonly connections: DatabaseConnectionConfig[];
	readonly activeDatabaseId?: string;
}

export class InvalidDatabaseAliasError extends Error {
	public constructor() {
		super(
			"Database alias must be 1-40 characters using lowercase letters, numbers, and hyphens.",
		);
		this.name = "InvalidDatabaseAliasError";
	}
}

export class DatabaseConnectionNotFoundError extends Error {
	public constructor(name: string) {
		super(`Database connection not found: ${name}`);
		this.name = "DatabaseConnectionNotFoundError";
	}
}

export class DatabaseAliasConflictError extends Error {
	public constructor(name: string) {
		super(`Database connection already exists: ${name}`);
		this.name = "DatabaseAliasConflictError";
	}
}

export class DatabaseConnectionRegistry {
	private readonly connections: DatabaseConnectionConfig[];
	private readonly activeDatabaseId: string | undefined;

	public constructor(config: QcpConfig) {
		this.connections = [...config.databaseConnections];
		this.activeDatabaseId = config.activeDatabaseId;
	}

	public list(): DatabaseConnectionConfig[] {
		return [...this.connections].sort((a, b) => a.name.localeCompare(b.name));
	}

	public findByName(name: string): DatabaseConnectionConfig | undefined {
		return this.connections.find((connection) => connection.name === name);
	}

	public findById(id: string): DatabaseConnectionConfig | undefined {
		return this.connections.find((connection) => connection.id === id);
	}

	public getActive(): DatabaseConnectionConfig | undefined {
		if (this.activeDatabaseId) {
			const active = this.findById(this.activeDatabaseId);
			if (active) return active;
		}

		return this.connections[0];
	}

	public resolveActive(name?: string): ActiveDatabaseConnection | undefined {
		const connection = name ? this.findByName(name) : this.getActive();
		if (!connection) return undefined;

		return {
			id: connection.id,
			name: connection.name,
			databaseType: connection.databaseType,
			databaseUrl: resolveDatabaseUrlForConnection(connection),
			prismaSchemaPath: connection.prismaSchemaPath,
			prismaDatasourceName: connection.prismaDatasourceName,
			amazonMarketingCloud:
				resolveAmazonMarketingCloudConfigForConnection(connection),
		};
	}

	public upsert(
		input: UpsertDatabaseConnectionInput,
		options: { readonly setActive?: boolean } = {},
	): DatabaseConnectionRegistrySnapshot {
		const name = normalizeDatabaseAlias(input.name);
		const existing = this.findByName(name);
		const now = new Date().toISOString();
		const connection: DatabaseConnectionConfig = {
			id: existing?.id ?? uuidv7(),
			name,
			databaseType: input.databaseType,
			databaseUrl: input.databaseUrl,
			prismaSchemaPath: input.prismaSchemaPath,
			prismaDatasourceName: input.prismaDatasourceName,
			amazonMarketingCloud:
				input.databaseType === "amazon-marketing-cloud"
					? input.amazonMarketingCloud
					: undefined,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		};

		const connections = existing
			? this.connections.map((item) =>
					item.id === existing.id ? connection : item,
				)
			: [...this.connections, connection];

		return {
			connections,
			activeDatabaseId:
				options.setActive === false ? this.activeDatabaseId : connection.id,
		};
	}

	public use(name: string): DatabaseConnectionRegistrySnapshot {
		const connection = this.findByName(name);
		if (!connection) {
			throw new DatabaseConnectionNotFoundError(name);
		}

		return {
			connections: this.connections,
			activeDatabaseId: connection.id,
		};
	}

	public update(
		name: string,
		input: UpdateDatabaseConnectionInput,
		options: { readonly setActive?: boolean } = {},
	): DatabaseConnectionRegistrySnapshot {
		const normalizedName = normalizeDatabaseAlias(name);
		const existing = this.findByName(normalizedName);
		if (!existing) {
			throw new DatabaseConnectionNotFoundError(normalizedName);
		}

		const nextName = input.name
			? normalizeDatabaseAlias(input.name)
			: existing.name;
		const conflict = this.findByName(nextName);
		if (conflict && conflict.id !== existing.id) {
			throw new DatabaseAliasConflictError(nextName);
		}

		const databaseType = input.databaseType ?? existing.databaseType;
		const connection: DatabaseConnectionConfig = {
			...existing,
			name: nextName,
			databaseType,
			databaseUrl: input.databaseUrl ?? existing.databaseUrl,
			prismaSchemaPath:
				databaseType === "prisma-postgres"
					? (input.prismaSchemaPath ?? existing.prismaSchemaPath)
					: undefined,
			prismaDatasourceName:
				databaseType === "prisma-postgres"
					? (input.prismaDatasourceName ?? existing.prismaDatasourceName)
					: undefined,
			amazonMarketingCloud:
				databaseType === "amazon-marketing-cloud"
					? (input.amazonMarketingCloud ?? existing.amazonMarketingCloud)
					: undefined,
			updatedAt: new Date().toISOString(),
		};

		return {
			connections: this.connections.map((item) =>
				item.id === existing.id ? connection : item,
			),
			activeDatabaseId:
				options.setActive === true ? connection.id : this.activeDatabaseId,
		};
	}

	public remove(name: string): DatabaseConnectionRegistrySnapshot {
		const connection = this.findByName(name);
		if (!connection) {
			throw new DatabaseConnectionNotFoundError(name);
		}

		const connections = this.connections.filter(
			(item) => item.id !== connection.id,
		);
		const activeDatabaseId =
			this.activeDatabaseId === connection.id
				? [...connections].sort((a, b) => a.name.localeCompare(b.name))[0]?.id
				: this.activeDatabaseId;

		return {
			connections,
			activeDatabaseId,
		};
	}
}

export function normalizeDatabaseAlias(alias: string): string {
	const normalized = alias.trim().toLowerCase();
	if (!isValidDatabaseAlias(normalized)) {
		throw new InvalidDatabaseAliasError();
	}

	return normalized;
}

export function isValidDatabaseAlias(alias: string): boolean {
	return /^[a-z0-9][a-z0-9-]{0,39}$/.test(alias);
}

export function resolveDatabaseUrlForConnection(
	connection: DatabaseConnectionConfig,
): string {
	if (connection.databaseType === "amazon-marketing-cloud") {
		return (
			process.env.QCP_AMC_API_BASE_URL ??
			connection.amazonMarketingCloud?.apiBaseUrl ??
			connection.databaseUrl
		);
	}

	if (connection.databaseType === "prisma-postgres") {
		return (
			process.env.PRISMA_DATABASE_URL ??
			connection.databaseUrl ??
			process.env.DATABASE_URL ??
			process.env.QCP_DATABASE_URL
		);
	}

	return (
		connection.databaseUrl ??
		process.env.DATABASE_URL ??
		process.env.QCP_DATABASE_URL
	);
}

export function resolveAmazonMarketingCloudConfigForConnection(
	connection: DatabaseConnectionConfig,
): AmazonMarketingCloudConnectionConfig | undefined {
	if (connection.databaseType !== "amazon-marketing-cloud") return undefined;
	const configured = connection.amazonMarketingCloud;
	if (!configured) return undefined;

	return {
		region: parseAmazonMarketingCloudRegion(
			process.env.QCP_AMC_REGION ?? configured.region,
			configured.region,
		),
		apiBaseUrl:
			process.env.QCP_AMC_API_BASE_URL ??
			configured.apiBaseUrl ??
			connection.databaseUrl,
		instanceId: process.env.QCP_AMC_INSTANCE_ID ?? configured.instanceId,
		clientId: process.env.QCP_AMC_CLIENT_ID ?? configured.clientId,
		clientSecret: process.env.QCP_AMC_CLIENT_SECRET ?? configured.clientSecret,
		refreshToken: process.env.QCP_AMC_REFRESH_TOKEN ?? configured.refreshToken,
		accessToken: process.env.QCP_AMC_ACCESS_TOKEN ?? configured.accessToken,
		accessTokenExpiresAt: configured.accessTokenExpiresAt,
		advertiserId: process.env.QCP_AMC_ADVERTISER_ID ?? configured.advertiserId,
		marketplaceId:
			process.env.QCP_AMC_MARKETPLACE_ID ?? configured.marketplaceId,
	};
}

function parseAmazonMarketingCloudRegion(
	value: string,
	fallback: AmazonMarketingCloudConnectionConfig["region"],
): AmazonMarketingCloudConnectionConfig["region"] {
	const normalized = value.trim().toUpperCase();
	if (normalized === "NA" || normalized === "EU" || normalized === "FE") {
		return normalized;
	}
	return fallback;
}
