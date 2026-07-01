import { z } from "zod";
import { AutomationConfigError, AutomationControlApiError } from "./errors.js";
import {
	AutomationListResponseSchema,
	AutomationModeSchema,
	AutomationMutationResponseSchema,
	AutomationStatusResponseSchema,
	SubmitAutomationResponseSchema,
	type AutomationListResponse,
	type AutomationMode,
	type AutomationMutationResponse,
	type AutomationStatusResponse,
	type SubmitAutomationResponse,
} from "./types.js";

export interface SubmitAutomationDraftInput {
	readonly query: string;
	readonly requestedBy: string;
	readonly mode: AutomationMode;
}

export interface ApproveAutomationInput {
	readonly requestId: string;
	readonly approvedBy: string;
}

export interface DeleteAutomationControlInput {
	readonly automationId: string;
	readonly deletedBy: string;
}

export interface RunAutomationControlInput {
	readonly automationId: string;
	readonly requestedBy: string;
}

export interface AutomationControlApi {
	submitDraft(
		input: SubmitAutomationDraftInput,
	): Promise<SubmitAutomationResponse>;
	getStatus(requestId: string): Promise<AutomationStatusResponse>;
	approve(input: ApproveAutomationInput): Promise<AutomationMutationResponse>;
	list(): Promise<AutomationListResponse>;
	delete(
		input: DeleteAutomationControlInput,
	): Promise<AutomationMutationResponse>;
	run(input: RunAutomationControlInput): Promise<AutomationMutationResponse>;
}

export interface AutomationControlClientOptions {
	readonly baseUrl?: string;
	readonly token?: string;
	readonly fetch?: FetchLike;
}

type FetchLike = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

const SubmitAutomationDraftInputSchema = z.object({
	query: z.string().min(1),
	requestedBy: z.string().min(1),
	mode: AutomationModeSchema,
});

export class AutomationControlClient implements AutomationControlApi {
	private readonly baseUrl: string;
	private readonly token?: string;
	private readonly fetchFn: FetchLike;

	public constructor(options: AutomationControlClientOptions = {}) {
		const baseUrl = options.baseUrl ?? process.env.QCP_AUTOMATION_CONTROL_URL;
		if (!baseUrl) {
			throw new AutomationConfigError(
				"QCP_AUTOMATION_CONTROL_URL is required for `qcp automation`.",
			);
		}

		this.baseUrl = baseUrl;
		this.token = options.token ?? process.env.QCP_AUTOMATION_CONTROL_TOKEN;
		this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
	}

	public async submitDraft(
		input: SubmitAutomationDraftInput,
	): Promise<SubmitAutomationResponse> {
		const body = SubmitAutomationDraftInputSchema.parse(input);
		const response = await this.request("POST", "/automation/requests", body);
		return SubmitAutomationResponseSchema.parse(response);
	}

	public async getStatus(requestId: string): Promise<AutomationStatusResponse> {
		const response = await this.request(
			"GET",
			`/automation/requests/${encodeURIComponent(requestId)}`,
		);
		return AutomationStatusResponseSchema.parse(response);
	}

	public async approve(
		input: ApproveAutomationInput,
	): Promise<AutomationMutationResponse> {
		const response = await this.request(
			"POST",
			`/automation/requests/${encodeURIComponent(input.requestId)}/approve`,
			{
				approvedBy: input.approvedBy,
			},
		);
		return AutomationMutationResponseSchema.parse(response);
	}

	public async list(): Promise<AutomationListResponse> {
		const response = await this.request("GET", "/automation");
		return AutomationListResponseSchema.parse(response);
	}

	public async delete(
		input: DeleteAutomationControlInput,
	): Promise<AutomationMutationResponse> {
		const response = await this.request(
			"DELETE",
			`/automation/${encodeURIComponent(input.automationId)}`,
			{
				deletedBy: input.deletedBy,
			},
		);
		return AutomationMutationResponseSchema.parse(response);
	}

	public async run(
		input: RunAutomationControlInput,
	): Promise<AutomationMutationResponse> {
		const response = await this.request(
			"POST",
			`/automation/${encodeURIComponent(input.automationId)}/run`,
			{
				requestedBy: input.requestedBy,
			},
		);
		return AutomationMutationResponseSchema.parse(response);
	}

	private async request(
		method: "GET" | "POST" | "DELETE",
		path: string,
		body?: Record<string, unknown>,
	): Promise<unknown> {
		const response = await this.fetchFn(this.url(path), {
			method,
			headers: this.headers(body !== undefined),
			body: body === undefined ? undefined : JSON.stringify(body),
		});

		if (!response.ok) {
			const detail = await response.text();
			throw new AutomationControlApiError(
				`Automation control API request failed: ${method} ${path}`,
				{
					status: response.status,
					cause: detail,
				},
			);
		}

		if (response.status === 204) return { ok: true };

		return response.json();
	}

	private headers(hasBody: boolean): HeadersInit {
		const headers: Record<string, string> = {
			Accept: "application/json",
		};

		if (hasBody) {
			headers["Content-Type"] = "application/json";
		}

		if (this.token) {
			headers.Authorization = `Bearer ${this.token}`;
		}

		return headers;
	}

	private url(path: string): URL {
		const base = this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`;
		return new URL(path.replace(/^\//, ""), base);
	}
}

export function createAutomationControlClient(): AutomationControlApi {
	return new AutomationControlClient();
}
