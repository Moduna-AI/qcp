import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
	AutomationConfigError,
	AutomationControlApiError,
	getAutomationErrorMessage,
} from "./errors.js";
import {
	createAutomationRegistryFromEnv,
	type AutomationRegistry,
} from "./registry.js";
import {
	AUTOMATION_EVENT_NAMES,
	AutomationApprovedEventSchema,
	AutomationDeletedEventSchema,
	AutomationExecuteEventSchema,
	AutomationModeSchema,
	AutomationRequestedEventSchema,
	type AutomationMutationResponse,
	type AutomationStatusResponse,
	type SubmitAutomationResponse,
} from "./types.js";
import { qcpAutomationInngest } from "./functions.js";

export interface AutomationControlHandlerOptions {
	readonly registry?: AutomationRegistry;
	readonly token?: string;
}

const SubmitRequestBodySchema = z.object({
	query: z.string().min(1),
	requestedBy: z.string().min(1),
	mode: AutomationModeSchema.default("production"),
});

const ApproveRequestBodySchema = z.object({
	approvedBy: z.string().min(1),
});

const DeleteRequestBodySchema = z.object({
	deletedBy: z.string().min(1),
});

const RunRequestBodySchema = z.object({
	requestedBy: z.string().min(1),
});

export async function handleAutomationControlRequest(
	request: Request,
	options: AutomationControlHandlerOptions = {},
): Promise<Response> {
	const authResponse = validateControlAuth(request, options.token);
	if (authResponse) return authResponse;

	const registry = options.registry ?? createAutomationRegistryFromEnv();
	const url = new URL(request.url);
	const segments = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);

	try {
		await registry.ensureSchema();

		if (
			request.method === "POST" &&
			matches(segments, ["automation", "requests"])
		) {
			return createAutomationRequest(request, registry);
		}

		if (
			request.method === "GET" &&
			segments.length === 3 &&
			segments[0] === "automation" &&
			segments[1] === "requests"
		) {
			return getAutomationRequestStatus(segments[2], registry);
		}

		if (
			request.method === "POST" &&
			segments.length === 4 &&
			segments[0] === "automation" &&
			segments[1] === "requests" &&
			segments[3] === "approve"
		) {
			return approveAutomationRequest(request, segments[2], registry);
		}

		if (request.method === "GET" && matches(segments, ["automation"])) {
			const automations = await registry.listAutomations();
			return jsonResponse({ automations });
		}

		if (
			request.method === "DELETE" &&
			segments.length === 2 &&
			segments[0] === "automation"
		) {
			return deleteAutomation(request, segments[1], registry);
		}

		if (
			request.method === "POST" &&
			segments.length === 3 &&
			segments[0] === "automation" &&
			segments[2] === "run"
		) {
			return runAutomation(request, segments[1], registry);
		}

		return jsonResponse({ ok: false, message: "Not found" }, 404);
	} catch (error: unknown) {
		return jsonResponse(
			{
				ok: false,
				message: getAutomationErrorMessage(error),
			},
			error instanceof AutomationConfigError ||
				error instanceof AutomationControlApiError
				? 400
				: 500,
		);
	}
}

async function createAutomationRequest(
	request: Request,
	registry: AutomationRegistry,
): Promise<Response> {
	const body = SubmitRequestBodySchema.parse(await readJson(request));
	const now = new Date().toISOString();
	const event = AutomationRequestedEventSchema.parse({
		requestId: `req_${randomUUID()}`,
		query: body.query,
		requestedBy: body.requestedBy,
		mode: body.mode,
		createdAt: now,
	});

	await registry.upsertRequest(event);
	await qcpAutomationInngest.send({
		name: AUTOMATION_EVENT_NAMES.requested,
		data: event,
	});

	const response: SubmitAutomationResponse = {
		requestId: event.requestId,
		status: "queued",
		statusUrl: new URL(
			`/automation/requests/${event.requestId}`,
			request.url,
		).toString(),
	};
	return jsonResponse(response, 202);
}

async function getAutomationRequestStatus(
	requestId: string,
	registry: AutomationRegistry,
): Promise<Response> {
	const request = await registry.getRequest(requestId);
	if (!request) {
		return jsonResponse(
			{ ok: false, message: "Automation request not found" },
			404,
		);
	}

	const definition = request.automationId
		? await registry.getDefinition(request.automationId)
		: undefined;
	const latestRun = definition
		? await registry.getLatestRun(definition.id)
		: undefined;
	const response: AutomationStatusResponse = {
		request,
		definition: definition ?? undefined,
		latestRun: latestRun ?? undefined,
	};
	return jsonResponse(response);
}

async function approveAutomationRequest(
	request: Request,
	requestId: string,
	registry: AutomationRegistry,
): Promise<Response> {
	const body = ApproveRequestBodySchema.parse(await readJson(request));
	const event = AutomationApprovedEventSchema.parse({
		requestId,
		approvedBy: body.approvedBy,
		approvedAt: new Date().toISOString(),
	});

	await qcpAutomationInngest.send({
		name: AUTOMATION_EVENT_NAMES.approved,
		data: event,
	});

	const current = await registry.getRequest(requestId);
	const response: AutomationMutationResponse = {
		ok: true,
		message: "Approval event submitted.",
		request: current ?? undefined,
	};
	return jsonResponse(response, 202);
}

async function deleteAutomation(
	request: Request,
	automationId: string,
	registry: AutomationRegistry,
): Promise<Response> {
	const body = DeleteRequestBodySchema.parse(await readJson(request));
	const event = AutomationDeletedEventSchema.parse({
		automationId,
		deletedBy: body.deletedBy,
		deletedAt: new Date().toISOString(),
	});

	await qcpAutomationInngest.send({
		name: AUTOMATION_EVENT_NAMES.deleted,
		data: event,
	});

	const definition = await registry.getDefinition(automationId);
	const response: AutomationMutationResponse = {
		ok: true,
		message: "Deletion event submitted.",
		definition: definition ?? undefined,
	};
	return jsonResponse(response, 202);
}

async function runAutomation(
	request: Request,
	automationId: string,
	registry: AutomationRegistry,
): Promise<Response> {
	const body = RunRequestBodySchema.parse(await readJson(request));
	const event = AutomationExecuteEventSchema.parse({
		automationId,
		requestedBy: body.requestedBy,
		requestedAt: new Date().toISOString(),
		runReason: "manual",
	});

	await qcpAutomationInngest.send({
		name: AUTOMATION_EVENT_NAMES.execute,
		data: event,
	});

	const definition = await registry.getDefinition(automationId);
	const latestRun = await registry.getLatestRun(automationId);
	const response: AutomationMutationResponse = {
		ok: true,
		message: "Run event submitted.",
		definition: definition ?? undefined,
		run: latestRun ?? undefined,
	};
	return jsonResponse(response, 202);
}

function validateControlAuth(
	request: Request,
	overrideToken: string | undefined,
): Response | null {
	const expectedToken =
		overrideToken ?? process.env.QCP_AUTOMATION_CONTROL_TOKEN;
	if (!expectedToken) return null;

	const actual = request.headers.get("authorization");
	if (actual !== `Bearer ${expectedToken}`) {
		return jsonResponse({ ok: false, message: "Unauthorized" }, 401);
	}

	return null;
}

async function readJson(request: Request): Promise<unknown> {
	return request.json();
}

function matches(
	segments: readonly string[],
	expected: readonly string[],
): boolean {
	return (
		segments.length === expected.length &&
		segments.every((segment, index) => segment === expected[index])
	);
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
		},
	});
}
