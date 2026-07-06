import type {
	ActiveDatabaseConnection,
	DatabaseSchema,
} from "@/types/index.js";
import { AmazonMarketingCloudClient } from "./client.js";
import { resolveAmazonMarketingCloudConnectionConfig } from "./config.js";
import type { AmcDataSource } from "./types.js";

export async function scanAmazonMarketingCloudSchema(
	connection: ActiveDatabaseConnection,
	options: {
		readonly client?: AmazonMarketingCloudClient;
		readonly onTokenRefresh?: (
			accessToken: string,
			accessTokenExpiresAt: string,
		) => void | Promise<void>;
	} = {},
): Promise<DatabaseSchema> {
	const config = resolveAmazonMarketingCloudConnectionConfig(connection);
	const client =
		options.client ??
		new AmazonMarketingCloudClient({
			config,
			onTokenRefresh: options.onTokenRefresh,
		});
	const dataSources = await client.listDataSources();
	return amazonMarketingCloudDataSourcesToSchema(
		dataSources,
		config.instanceId,
	);
}

export function amazonMarketingCloudDataSourcesToSchema(
	dataSources: readonly AmcDataSource[],
	instanceId: string,
): DatabaseSchema {
	const tables = dataSources.map((dataSource) => ({
		schema: "amc",
		name: dataSource.dataSourceId,
		columns: (dataSource.columns ?? []).map((column) => ({
			name: column.name,
			type: normalizeAmcColumnType(column.columnType ?? column.dataType),
			nullable: true,
			defaultValue: undefined,
			isPrimaryKey: false,
		})),
		primaryKeys: [],
		foreignKeys: [],
		indexes: [],
	}));

	return {
		scannedAt: new Date().toISOString(),
		databaseName: `Amazon Marketing Cloud ${instanceId}`,
		tableCount: tables.length,
		tables,
	};
}

function normalizeAmcColumnType(value: string | undefined): string {
	const normalized = value?.trim();
	return normalized && normalized.length > 0 ? normalized : "unknown";
}
