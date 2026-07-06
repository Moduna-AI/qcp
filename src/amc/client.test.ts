import { describe, expect, test } from "bun:test";
import { AmazonMarketingCloudClient } from "./client.js";
import type { ResolvedAmazonMarketingCloudConfig } from "./types.js";

const config: ResolvedAmazonMarketingCloudConfig = {
	region: "NA",
	apiBaseUrl: "https://advertising-api.amazon.com",
	instanceId: "amc-instance",
	clientId: "client-id",
	clientSecret: "client-secret",
	refreshToken: "refresh-token",
	advertiserId: "advertiser-id",
	marketplaceId: "ATVPDKIKX0DER",
};

describe("AmazonMarketingCloudClient", () => {
	test("refreshes LWA token and injects AMC headers", async () => {
		const calls: Array<{ readonly url: string; readonly init?: RequestInit }> =
			[];
		const fetchFn = mockFetch(async (input, init) => {
			const url = String(input);
			calls.push({ url, init });
			if (url === "https://api.amazon.com/auth/o2/token") {
				return Response.json({
					access_token: "access-token",
					expires_in: 3600,
				});
			}
			return Response.json({ dataSources: [] });
		});
		const refreshed: string[] = [];
		const client = new AmazonMarketingCloudClient({
			config,
			fetch: fetchFn,
			now: () => new Date("2026-07-06T00:00:00.000Z"),
			onTokenRefresh: (accessToken, expiresAt) => {
				refreshed.push(`${accessToken}:${expiresAt}`);
			},
		});

		await client.listDataSources();

		expect(calls[0].url).toBe("https://api.amazon.com/auth/o2/token");
		expect(calls[1].url).toBe(
			"https://advertising-api.amazon.com/amc/reporting/amc-instance/dataSources",
		);
		const headers = new Headers(calls[1].init?.headers);
		expect(headers.get("Authorization")).toBe("Bearer access-token");
		expect(headers.get("Amazon-Advertising-API-ClientId")).toBe("client-id");
		expect(headers.get("Amazon-Advertising-API-AdvertiserId")).toBe(
			"advertiser-id",
		);
		expect(headers.get("Amazon-Advertising-API-MarketplaceId")).toBe(
			"ATVPDKIKX0DER",
		);
		expect(refreshed[0]).toBe("access-token:2026-07-06T01:00:00.000Z");
	});

	test("uses AMC workflow execution vendor media type", async () => {
		const calls: Array<{ readonly url: string; readonly init?: RequestInit }> =
			[];
		const fetchFn = mockFetch(async (input, init) => {
			const url = String(input);
			calls.push({ url, init });
			if (url === "https://api.amazon.com/auth/o2/token") {
				return Response.json({ access_token: "access-token" });
			}
			return Response.json({
				workflowExecutionId: "execution-id",
				status: "PENDING",
			});
		});
		const client = new AmazonMarketingCloudClient({ config, fetch: fetchFn });

		await client.createWorkflowExecution({
			sql: "SELECT 1",
			workflowId: "qcp-test",
			dryRun: true,
			timeWindowStart: "2026-07-01T00:00:00",
			timeWindowEnd: "2026-07-02T00:00:00",
			timeWindowTimeZone: "UTC",
		});

		const headers = new Headers(calls[1].init?.headers);
		expect(headers.get("Content-Type")).toBe(
			"application/vnd.amcworkflowexecutions.v1+json",
		);
		expect(headers.get("Accept")).toBe(
			"application/vnd.amcworkflowexecutions.v1+json",
		);
		expect(calls[1].init?.method).toBe("POST");
	});
});

function mockFetch(
	handler: (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	) => Promise<Response>,
): typeof fetch {
	return handler as unknown as typeof fetch;
}
