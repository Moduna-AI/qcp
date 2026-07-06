import { z } from "zod";
import type {
	AmcDataSource,
	AmcDownloadUrlsPage,
	AmcWorkflowExecution,
	ResolvedAmazonMarketingCloudConfig,
} from "./types.js";

const tokenResponseSchema = z.object({
	access_token: z.string(),
	expires_in: z.number().optional(),
	token_type: z.string().optional(),
});

const dataSourceColumnSchema = z
	.object({
		name: z.string(),
		description: z.string().optional(),
		columnType: z.string().optional(),
		dataType: z.string().optional(),
	})
	.passthrough();

const dataSourceSchema = z
	.object({
		dataSourceId: z.string(),
		name: z.string().optional(),
		description: z.string().optional(),
		columns: z.array(dataSourceColumnSchema).optional(),
	})
	.passthrough();

const workflowExecutionStatusSchema = z.enum([
	"PENDING",
	"RUNNING",
	"SUCCEEDED",
	"FAILED",
	"CANCELLED",
]);

const workflowExecutionSchema = z
	.object({
		workflowExecutionId: z.string(),
		workflowId: z.string().optional(),
		status: workflowExecutionStatusSchema,
		outputS3URI: z.string().optional(),
		createdTime: z.string().optional(),
		updatedTime: z.string().optional(),
		sqlQuery: z.string().optional(),
		errorReason: z.string().optional(),
		warnings: z.array(z.string()).optional(),
	})
	.passthrough();

const downloadUrlsPageSchema = z
	.object({
		downloadUrls: z.array(z.string()).default([]),
		metadataDownloadUrls: z.array(z.string()).default([]),
		nextToken: z.string().optional(),
	})
	.passthrough();

const WORKFLOW_EXECUTIONS_MEDIA_TYPE =
	"application/vnd.amcworkflowexecutions.v1+json";

export interface AmazonMarketingCloudClientOptions {
	readonly config: ResolvedAmazonMarketingCloudConfig;
	readonly fetch?: typeof fetch;
	readonly now?: () => Date;
	readonly onTokenRefresh?: (
		accessToken: string,
		accessTokenExpiresAt: string,
	) => void | Promise<void>;
}

export class AmazonMarketingCloudApiError extends Error {
	public constructor(
		message: string,
		readonly status: number,
		readonly body: string,
	) {
		super(message);
		this.name = "AmazonMarketingCloudApiError";
	}
}

export class AmazonMarketingCloudClient {
	private readonly config: ResolvedAmazonMarketingCloudConfig;
	private readonly fetchFn: typeof fetch;
	private readonly now: () => Date;
	private readonly onTokenRefresh:
		| AmazonMarketingCloudClientOptions["onTokenRefresh"]
		| undefined;
	private cachedAccessToken: string | undefined;
	private cachedAccessTokenExpiresAt: string | undefined;

	public constructor(options: AmazonMarketingCloudClientOptions) {
		this.config = options.config;
		this.fetchFn = options.fetch ?? fetch;
		this.now = options.now ?? (() => new Date());
		this.onTokenRefresh = options.onTokenRefresh;
		this.cachedAccessToken = options.config.accessToken;
		this.cachedAccessTokenExpiresAt = options.config.accessTokenExpiresAt;
	}

	public async listDataSources(): Promise<AmcDataSource[]> {
		const response = await this.requestJson<unknown>(
			`/amc/reporting/${encodeURIComponent(this.config.instanceId)}/dataSources`,
			{ method: "GET" },
		);
		const items = Array.isArray(response)
			? response
			: this.readArrayProperty(response, "dataSources");
		return z.array(dataSourceSchema).parse(items);
	}

	public async createWorkflowExecution(input: {
		readonly sql: string;
		readonly workflowId: string;
		readonly dryRun: boolean;
		readonly timeWindowStart: string;
		readonly timeWindowEnd: string;
		readonly timeWindowTimeZone: string;
	}): Promise<AmcWorkflowExecution> {
		const body = {
			dryRun: input.dryRun,
			timeWindowType: "EXPLICIT",
			timeWindowStart: input.timeWindowStart,
			timeWindowEnd: input.timeWindowEnd,
			timeWindowTimeZone: input.timeWindowTimeZone,
			workflow: {
				workflowId: input.workflowId,
				sqlQuery: input.sql,
			},
		};

		const response = await this.requestJson<unknown>(
			`/amc/reporting/${encodeURIComponent(this.config.instanceId)}/workflowExecutions`,
			{
				method: "POST",
				body: JSON.stringify(body),
				contentType: WORKFLOW_EXECUTIONS_MEDIA_TYPE,
				accept: WORKFLOW_EXECUTIONS_MEDIA_TYPE,
			},
		);
		return workflowExecutionSchema.parse(response);
	}

	public async getWorkflowExecution(
		workflowExecutionId: string,
	): Promise<AmcWorkflowExecution> {
		const response = await this.requestJson<unknown>(
			`/amc/reporting/${encodeURIComponent(this.config.instanceId)}/workflowExecutions/${encodeURIComponent(workflowExecutionId)}`,
			{
				method: "GET",
				accept: WORKFLOW_EXECUTIONS_MEDIA_TYPE,
			},
		);
		return workflowExecutionSchema.parse(response);
	}

	public async getWorkflowExecutionDownloadUrls(
		workflowExecutionId: string,
		nextToken?: string,
	): Promise<AmcDownloadUrlsPage> {
		const search = new URLSearchParams();
		if (nextToken) search.set("nextToken", nextToken);
		const suffix = search.size > 0 ? `?${search.toString()}` : "";
		const response = await this.requestJson<unknown>(
			`/amc/reporting/${encodeURIComponent(this.config.instanceId)}/workflowExecutions/${encodeURIComponent(workflowExecutionId)}/downloadUrls${suffix}`,
			{
				method: "GET",
				accept: WORKFLOW_EXECUTIONS_MEDIA_TYPE,
			},
		);
		return downloadUrlsPageSchema.parse(response);
	}

	public async downloadText(url: string): Promise<string> {
		const response = await this.fetchFn(url);
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new AmazonMarketingCloudApiError(
				`AMC result download failed with HTTP ${response.status}`,
				response.status,
				body,
			);
		}
		return await response.text();
	}

	public async refreshAccessToken(): Promise<{
		readonly accessToken: string;
		readonly accessTokenExpiresAt: string;
	}> {
		const body = new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: this.config.refreshToken,
			client_id: this.config.clientId,
			client_secret: this.config.clientSecret,
		});

		const response = await this.fetchFn(
			"https://api.amazon.com/auth/o2/token",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body,
			},
		);

		if (!response.ok) {
			const errorBody = await response.text().catch(() => "");
			throw new AmazonMarketingCloudApiError(
				`Amazon LWA token refresh failed with HTTP ${response.status}`,
				response.status,
				errorBody,
			);
		}

		const parsed = tokenResponseSchema.parse(await response.json());
		const expiresAt = new Date(
			this.now().getTime() + (parsed.expires_in ?? 3600) * 1000,
		).toISOString();

		await this.onTokenRefresh?.(parsed.access_token, expiresAt);
		this.cachedAccessToken = parsed.access_token;
		this.cachedAccessTokenExpiresAt = expiresAt;

		return {
			accessToken: parsed.access_token,
			accessTokenExpiresAt: expiresAt,
		};
	}

	private async requestJson<T>(
		path: string,
		options: {
			readonly method: string;
			readonly body?: string;
			readonly contentType?: string;
			readonly accept?: string;
		},
	): Promise<T> {
		const accessToken = await this.getAccessToken();
		const url = new URL(path, this.config.apiBaseUrl).toString();
		const response = await this.fetchFn(url, {
			method: options.method,
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Amazon-Advertising-API-ClientId": this.config.clientId,
				"Amazon-Advertising-API-AdvertiserId": this.config.advertiserId,
				"Amazon-Advertising-API-MarketplaceId": this.config.marketplaceId,
				"Content-Type": options.contentType ?? "application/json",
				Accept: options.accept ?? "application/json",
			},
			body: options.body,
		});

		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new AmazonMarketingCloudApiError(
				`AMC API request failed with HTTP ${response.status}`,
				response.status,
				body,
			);
		}

		return (await response.json()) as T;
	}

	private async getAccessToken(): Promise<string> {
		if (this.hasUsableAccessToken()) {
			return this.cachedAccessToken ?? "";
		}

		const refreshed = await this.refreshAccessToken();
		return refreshed.accessToken;
	}

	private hasUsableAccessToken(): boolean {
		if (!this.cachedAccessToken) return false;
		if (!this.cachedAccessTokenExpiresAt) return true;

		const expiresAt = Date.parse(this.cachedAccessTokenExpiresAt);
		if (Number.isNaN(expiresAt)) return false;

		return expiresAt - this.now().getTime() > 60_000;
	}

	private readArrayProperty(value: unknown, key: string): unknown[] {
		if (!value || typeof value !== "object") return [];
		const record = value as Record<string, unknown>;
		const candidate = record[key];
		return Array.isArray(candidate) ? candidate : [];
	}
}
