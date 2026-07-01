import { Inngest } from "inngest";
import { QcpAutomationAgent } from "@/agents/automation-agent.js";
import { DEFAULT_MODELS } from "@/config/index.js";
import type { ProviderName, QcpConfig } from "@/types/index.js";
import {
	AutomationConfigError,
	AutomationGenerationError,
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
	AutomationRequestedEventSchema,
	AutomationReviewedEventSchema,
	type AutomationAction,
	type AutomationDefinitionRecord,
} from "./types.js";

const DEFAULT_AUTOMATION_INNGEST_APP_ID = "qcp-automation";

export const qcpAutomationInngest = new Inngest({
	id:
		process.env.QCP_AUTOMATION_INNGEST_APP_ID ??
		DEFAULT_AUTOMATION_INNGEST_APP_ID,
});

export const automationRequestedFunction = qcpAutomationInngest.createFunction(
	{
		id: "qcp-automation-requested",
		name: "QCP Automation Requested",
		retries: 2,
		triggers: [{ event: AUTOMATION_EVENT_NAMES.requested }],
	},
	async ({ event, step }) => {
		const payload = AutomationRequestedEventSchema.parse(event.data);
		const registry = createAutomationRegistryFromEnv();

		await step.run("ensure-registry-schema", async () =>
			registry.ensureSchema(),
		);
		await step.run("store-request", async () =>
			registry.upsertRequest(payload),
		);
		await step.run("mark-generating", async () =>
			registry.markRequestGenerating(payload.requestId),
		);

		try {
			const draft = await step.run("generate-reviewed-draft", async () => {
				const agent = new QcpAutomationAgent();
				return agent.createDraft(payload.query, payload.mode);
			});

			await step.run("store-review", async () =>
				registry.storeReview({
					requestId: payload.requestId,
					spec: draft.spec,
					review: draft.review,
					validationIssues: draft.validation.issues,
				}),
			);
			await step.sendEvent("emit-reviewed-event", {
				name: AUTOMATION_EVENT_NAMES.reviewed,
				data: {
					requestId: payload.requestId,
					review: draft.review,
					reviewedAt: new Date().toISOString(),
				},
			});

			return {
				requestId: payload.requestId,
				status:
					draft.validation.issues.length === 0 ? "awaiting_approval" : "failed",
				review: draft.review,
			};
		} catch (error: unknown) {
			const message = getAutomationErrorMessage(error);
			await step.run("mark-generation-failed", async () =>
				registry.markRequestFailed(payload.requestId, message),
			);
			throw new AutomationGenerationError(message, { cause: error });
		}
	},
);

export const automationReviewedFunction = qcpAutomationInngest.createFunction(
	{
		id: "qcp-automation-reviewed",
		name: "QCP Automation Reviewed",
		retries: 1,
		triggers: [{ event: AUTOMATION_EVENT_NAMES.reviewed }],
	},
	async ({ event, step }) => {
		const payload = AutomationReviewedEventSchema.parse(event.data);
		return step.run("ack-reviewed", async () => ({
			requestId: payload.requestId,
			reviewedAt: payload.reviewedAt,
			summary: payload.review.summary,
		}));
	},
);

export const automationApprovedFunction = qcpAutomationInngest.createFunction(
	{
		id: "qcp-automation-approved",
		name: "QCP Automation Approved",
		retries: 2,
		triggers: [{ event: AUTOMATION_EVENT_NAMES.approved }],
	},
	async ({ event, step }) => {
		const payload = AutomationApprovedEventSchema.parse(event.data);
		const registry = createAutomationRegistryFromEnv();

		await step.run("ensure-registry-schema", async () =>
			registry.ensureSchema(),
		);
		await step.run("record-approval", async () =>
			registry.approveRequest({
				requestId: payload.requestId,
				approvedBy: payload.approvedBy,
				approvedAt: payload.approvedAt,
			}),
		);
		const definition = await step.run("activate-automation", async () =>
			registry.activateRequest(payload.requestId),
		);

		return {
			requestId: payload.requestId,
			automationId: definition.id,
			status: definition.status,
		};
	},
);

export const automationDeletedFunction = qcpAutomationInngest.createFunction(
	{
		id: "qcp-automation-deleted",
		name: "QCP Automation Deleted",
		retries: 2,
		triggers: [{ event: AUTOMATION_EVENT_NAMES.deleted }],
	},
	async ({ event, step }) => {
		const payload = AutomationDeletedEventSchema.parse(event.data);
		const registry = createAutomationRegistryFromEnv();

		await step.run("ensure-registry-schema", async () =>
			registry.ensureSchema(),
		);
		await step.run("soft-delete-automation", async () =>
			registry.softDeleteAutomation({
				automationId: payload.automationId,
				deletedBy: payload.deletedBy,
				deletedAt: payload.deletedAt,
			}),
		);

		return {
			automationId: payload.automationId,
			status: "deleted",
		};
	},
);

export const automationExecuteFunction = qcpAutomationInngest.createFunction(
	{
		id: "qcp-automation-execute",
		name: "QCP Automation Execute",
		retries: 1,
		triggers: [{ event: AUTOMATION_EVENT_NAMES.execute }],
	},
	async ({ event, step }) => {
		const payload = AutomationExecuteEventSchema.parse(event.data);
		const registry = createAutomationRegistryFromEnv();

		await step.run("ensure-registry-schema", async () =>
			registry.ensureSchema(),
		);
		const definition = await step.run("load-definition", async () =>
			registry.getDefinition(payload.automationId),
		);

		if (!definition || definition.status !== "active") {
			return {
				automationId: payload.automationId,
				status: "skipped",
				reason: "Automation is not active.",
			};
		}

		const run = await step.run("record-run-started", async () =>
			registry.recordRunStarted({
				automationId: definition.id,
				reason: payload.runReason,
				startedAt: payload.requestedAt,
			}),
		);

		try {
			const output = await step.run("execute-action", async () =>
				executeAutomationDefinition(definition),
			);
			const completedRun = await step.run("record-run-succeeded", async () =>
				registry.recordRunSucceeded(run.id, output),
			);

			return {
				automationId: payload.automationId,
				run: completedRun,
			};
		} catch (error: unknown) {
			const message = getAutomationErrorMessage(error);
			const failedRun = await step.run("record-run-failed", async () =>
				registry.recordRunFailed(run.id, message),
			);
			return {
				automationId: payload.automationId,
				run: failedRun,
			};
		}
	},
);

export const automationCronDispatcherFunction =
	qcpAutomationInngest.createFunction(
		{
			id: "qcp-automation-cron-dispatcher",
			name: "QCP Automation Cron Dispatcher",
			retries: 1,
			triggers: [{ cron: "* * * * *" }],
		},
		async ({ step }) => {
			const registry = createAutomationRegistryFromEnv();
			const now = new Date();

			await step.run("ensure-registry-schema", async () =>
				registry.ensureSchema(),
			);
			const dueAutomations = await step.run("list-due-automations", async () =>
				registry.listDueAutomations(now),
			);

			if (dueAutomations.length === 0) {
				return {
					dispatched: 0,
				};
			}

			await step.sendEvent(
				"dispatch-due-automations",
				dueAutomations.map((definition) => ({
					name: AUTOMATION_EVENT_NAMES.execute,
					data: {
						automationId: definition.id,
						requestedBy: "qcp-automation-cron-dispatcher",
						requestedAt: now.toISOString(),
						runReason: "cron",
					},
				})),
			);

			return {
				dispatched: dueAutomations.length,
			};
		},
	);

export const qcpAutomationFunctions = [
	automationRequestedFunction,
	automationReviewedFunction,
	automationApprovedFunction,
	automationDeletedFunction,
	automationExecuteFunction,
	automationCronDispatcherFunction,
] as const;

export async function executeAutomationDefinition(
	definition: AutomationDefinitionRecord,
): Promise<Record<string, unknown>> {
	const action = definition.spec.action;

	switch (action.type) {
		case "test.heartbeat":
			return {
				type: action.type,
				automationId: definition.id,
				message: action.message,
				timestamp: new Date().toISOString(),
			};
		case "qcp.ask.readonly":
			return executeReadOnlyQcpAskAction(definition, action);
		default: {
			const exhaustive: never = action;
			return exhaustive;
		}
	}
}

async function executeReadOnlyQcpAskAction(
	definition: AutomationDefinitionRecord,
	action: Extract<AutomationAction, { type: "qcp.ask.readonly" }>,
): Promise<Record<string, unknown>> {
	const databaseUrl = process.env[action.databaseSecretEnv];
	if (!databaseUrl) {
		throw new AutomationConfigError(
			`Missing database secret env ref: ${action.databaseSecretEnv}`,
		);
	}

	const provider = resolveAutomationProvider();
	const apiKey = resolveProviderApiKey(provider);
	if (!apiKey) {
		throw new AutomationConfigError(
			`Missing API key for automation qcp ask provider: ${provider}`,
		);
	}

	const [{ scanSchema }, { QcpSupervisorAgent }] = await Promise.all([
		import("@/schema/index.js"),
		import("@/agents/supervisor-agent.js"),
	]);
	const now = new Date().toISOString();
	const schema = await scanSchema(databaseUrl);
	const config = buildAutomationQcpConfig({
		provider,
		apiKey,
		databaseUrl,
		connectionName: action.connectionName,
		createdAt: now,
	});
	const supervisor = new QcpSupervisorAgent({
		config,
		command: "qcp automation execute",
		sessionId: definition.id,
		connectionId: "automation-cloud",
		connectionName: action.connectionName,
		databaseUrl,
		schema,
	});
	const response = await supervisor.generateResponse(action.question);

	return {
		type: action.type,
		automationId: definition.id,
		connectionName: action.connectionName,
		question: action.question,
		maxRows: action.maxRows,
		answer: response.text,
		latencyMs: response.latencyMs,
		tokensIn: response.tokensIn,
		tokensOut: response.tokensOut,
	};
}

function resolveAutomationProvider(): ProviderName {
	const configured = process.env.QCP_AUTOMATION_QCP_PROVIDER;
	if (configured && isProviderName(configured)) return configured;
	if (process.env.OPENAI_API_KEY) return "openai";
	if (process.env.GEMINI_API_KEY) return "gemini";
	if (process.env.ANTHROPIC_API_KEY) return "anthropic";
	return "openai";
}

function isProviderName(value: string): value is ProviderName {
	return ["gemini", "openai", "anthropic", "ollama"].includes(value);
}

function resolveProviderApiKey(provider: ProviderName): string | undefined {
	switch (provider) {
		case "gemini":
			return process.env.GEMINI_API_KEY;
		case "openai":
			return process.env.OPENAI_API_KEY;
		case "anthropic":
			return process.env.ANTHROPIC_API_KEY;
		case "ollama":
			return "local";
		default: {
			const exhaustive: never = provider;
			return exhaustive;
		}
	}
}

function buildAutomationQcpConfig(input: {
	readonly provider: ProviderName;
	readonly apiKey: string;
	readonly databaseUrl: string;
	readonly connectionName: string;
	readonly createdAt: string;
}): QcpConfig {
	return {
		version: "automation-v1",
		installId: "qcp-automation-cloud",
		databaseType: "other-postgres",
		databaseUrl: input.databaseUrl,
		databaseConnections: [
			{
				id: "automation-cloud",
				name: input.connectionName,
				databaseType: "other-postgres",
				databaseUrl: input.databaseUrl,
				createdAt: input.createdAt,
				updatedAt: input.createdAt,
			},
		],
		activeDatabaseId: "automation-cloud",
		provider: input.provider,
		model:
			process.env.QCP_AUTOMATION_QCP_MODEL ?? DEFAULT_MODELS[input.provider],
		telemetry: false,
		safeMode: true,
		showSql: false,
		showMetrics: false,
		sensitiveTablePatterns: [
			"user",
			"customer",
			"employee",
			"password",
			"token",
			"secret",
			"credential",
		],
		apiKeys: {
			gemini: input.provider === "gemini" ? input.apiKey : undefined,
			openai: input.provider === "openai" ? input.apiKey : undefined,
			anthropic: input.provider === "anthropic" ? input.apiKey : undefined,
		},
	};
}

export async function setupAutomationRegistry(
	registry: AutomationRegistry,
): Promise<void> {
	await registry.ensureSchema();
}
