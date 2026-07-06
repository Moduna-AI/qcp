import { resolveAmazonMarketingCloudConfigForConnection } from "@/config/database-connection-registry.js";
import type {
	ActiveDatabaseConnection,
	AmazonMarketingCloudConnectionConfig,
	DatabaseConnectionConfig,
} from "@/types/index.js";
import type { ResolvedAmazonMarketingCloudConfig } from "./types.js";

export const DEFAULT_AMC_API_BASE_URL = "https://advertising-api.amazon.com";

export class AmazonMarketingCloudConfigError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "AmazonMarketingCloudConfigError";
	}
}

export function defaultAmazonMarketingCloudApiBaseUrl(
	region: AmazonMarketingCloudConnectionConfig["region"],
): string {
	switch (region) {
		case "NA":
			return "https://advertising-api.amazon.com";
		case "EU":
			return "https://advertising-api-eu.amazon.com";
		case "FE":
			return "https://advertising-api-fe.amazon.com";
		default: {
			const _exhaustive: never = region;
			return _exhaustive;
		}
	}
}

export function resolveAmazonMarketingCloudConnectionConfig(
	connection: ActiveDatabaseConnection | DatabaseConnectionConfig,
): ResolvedAmazonMarketingCloudConfig {
	const configured =
		"createdAt" in connection
			? resolveAmazonMarketingCloudConfigForConnection(connection)
			: connection.amazonMarketingCloud;

	if (connection.databaseType !== "amazon-marketing-cloud" || !configured) {
		throw new AmazonMarketingCloudConfigError(
			"Active connection is not an Amazon Marketing Cloud connection.",
		);
	}

	const apiBaseUrl =
		process.env.QCP_AMC_API_BASE_URL ??
		configured.apiBaseUrl ??
		connection.databaseUrl;

	const resolved: ResolvedAmazonMarketingCloudConfig = {
		...configured,
		apiBaseUrl,
		instanceId: process.env.QCP_AMC_INSTANCE_ID ?? configured.instanceId,
		clientId: process.env.QCP_AMC_CLIENT_ID ?? configured.clientId,
		clientSecret: process.env.QCP_AMC_CLIENT_SECRET ?? configured.clientSecret,
		refreshToken: process.env.QCP_AMC_REFRESH_TOKEN ?? configured.refreshToken,
		accessToken: process.env.QCP_AMC_ACCESS_TOKEN ?? configured.accessToken,
		advertiserId: process.env.QCP_AMC_ADVERTISER_ID ?? configured.advertiserId,
		marketplaceId:
			process.env.QCP_AMC_MARKETPLACE_ID ?? configured.marketplaceId,
	};

	validateResolvedAmazonMarketingCloudConfig(resolved);
	return resolved;
}

export function validateResolvedAmazonMarketingCloudConfig(
	config: ResolvedAmazonMarketingCloudConfig,
): void {
	const missing = [
		["apiBaseUrl", config.apiBaseUrl],
		["instanceId", config.instanceId],
		["clientId", config.clientId],
		["clientSecret", config.clientSecret],
		["refreshToken", config.refreshToken],
		["advertiserId", config.advertiserId],
		["marketplaceId", config.marketplaceId],
	].flatMap(([key, value]) => (value ? [] : [key]));

	if (missing.length > 0) {
		throw new AmazonMarketingCloudConfigError(
			`Amazon Marketing Cloud config is missing: ${missing.join(", ")}`,
		);
	}
}
