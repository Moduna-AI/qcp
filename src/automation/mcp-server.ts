import { randomUUID } from "node:crypto";
import { createTool } from "@mastra/core/tools";
import { MCPServer } from "@mastra/mcp";
import { z } from "zod";
import { QcpAutomationAgent } from "@/agents/automation-agent.js";
import { AutomationRegistryError } from "./errors.js";
import { executeAutomationDefinition } from "./functions.js";
import {
	createAutomationRegistryFromEnv,
	type AutomationRegistry,
} from "./registry.js";
import { createAutomationReview, validateAutomationSpec } from "./spec.js";
import {
	AutomationListItemSchema,
	AutomationModeSchema,
	AutomationReviewSchema,
	AutomationRunRecordSchema,
	AutomationSpecV1Schema,
	type AutomationMode,
} from "./types.js";

export interface QcpAutomationMcpServerOptions {
	readonly agent?: QcpAutomationAgent;
	readonly registry?: AutomationRegistry;
}

const ValidationOutputSchema = z.object({
	valid: z.boolean(),
	issues: z.array(z.string()),
});

export function createQcpAutomationMcpServer(
	options: QcpAutomationMcpServerOptions = {},
): MCPServer {
	const agent = options.agent ?? new QcpAutomationAgent();
	const getRegistry = (): AutomationRegistry =>
		options.registry ?? createAutomationRegistryFromEnv();

	return new MCPServer({
		name: "qcp-automation",
		version: "1.0.0",
		tools: {
			qcp_generate_automation_draft: createTool({
				id: "qcp_generate_automation_draft",
				description:
					"Generate a reviewed qcp automation draft from a natural-language request. The draft is not activated.",
				inputSchema: z.object({
					query: z.string().min(1),
					mode: AutomationModeSchema.default("production"),
				}),
				outputSchema: z.object({
					spec: AutomationSpecV1Schema,
					review: AutomationReviewSchema,
					validation: ValidationOutputSchema,
				}),
				mcp: {
					annotations: {
						title: "Generate Automation Draft",
						readOnlyHint: true,
						destructiveHint: false,
						idempotentHint: false,
						openWorldHint: false,
					},
				},
				execute: async ({ query, mode }) => {
					const draft = await agent.createDraft(query, mode ?? "production");
					return {
						spec: draft.spec,
						review: draft.review,
						validation: {
							valid: draft.validation.valid,
							issues: [...draft.validation.issues],
						},
					};
				},
			}),
			qcp_validate_automation_spec: createTool({
				id: "qcp_validate_automation_spec",
				description:
					"Validate a qcp automation spec before review or activation.",
				inputSchema: z.object({
					spec: AutomationSpecV1Schema,
				}),
				outputSchema: ValidationOutputSchema,
				mcp: {
					annotations: {
						title: "Validate Automation Spec",
						readOnlyHint: true,
						destructiveHint: false,
						idempotentHint: true,
						openWorldHint: false,
					},
				},
				execute: async ({ spec }) => {
					const parsedSpec = AutomationSpecV1Schema.parse(spec);
					const result = validateAutomationSpec(parsedSpec);
					return {
						valid: result.valid,
						issues: [...result.issues],
					};
				},
			}),
			qcp_generate_automation_review: createTool({
				id: "qcp_generate_automation_review",
				description:
					"Generate the human setup review for a qcp automation spec.",
				inputSchema: z.object({
					spec: AutomationSpecV1Schema,
				}),
				outputSchema: AutomationReviewSchema,
				mcp: {
					annotations: {
						title: "Generate Automation Review",
						readOnlyHint: true,
						destructiveHint: false,
						idempotentHint: true,
						openWorldHint: false,
					},
				},
				execute: async ({ spec }) => {
					const parsedSpec = AutomationSpecV1Schema.parse(spec);
					const validation = validateAutomationSpec(parsedSpec);
					return createAutomationReview(parsedSpec, validation.issues);
				},
			}),
			qcp_activate_automation_request: createTool({
				id: "qcp_activate_automation_request",
				description:
					"Activate a reviewed qcp automation request after explicit human approval.",
				requireApproval: true,
				inputSchema: z.object({
					requestId: z.string().min(1),
					approvedBy: z.string().min(1).default("qcp-automation-mcp"),
				}),
				outputSchema: z.object({
					automationId: z.string(),
					status: z.literal("active"),
				}),
				execute: async ({ requestId, approvedBy }) => {
					const registry = getRegistry();
					const approvedAt = new Date().toISOString();
					await registry.ensureSchema();
					await registry.approveRequest({
						requestId,
						approvedBy: approvedBy ?? "qcp-automation-mcp",
						approvedAt,
					});
					const definition = await registry.activateRequest(requestId);
					return {
						automationId: definition.id,
						status: "active" as const,
					};
				},
			}),
			qcp_list_automations: createTool({
				id: "qcp_list_automations",
				description: "List active and draft qcp automations.",
				inputSchema: z.object({}),
				outputSchema: z.object({
					automations: z.array(AutomationListItemSchema),
				}),
				mcp: {
					annotations: {
						title: "List Automations",
						readOnlyHint: true,
						destructiveHint: false,
						idempotentHint: true,
						openWorldHint: false,
					},
				},
				execute: async () => {
					const registry = getRegistry();
					await registry.ensureSchema();
					const automations = await registry.listAutomations();
					return {
						automations: [...automations],
					};
				},
			}),
			qcp_delete_automation: createTool({
				id: "qcp_delete_automation",
				description:
					"Soft-delete a qcp automation so future scheduler dispatches skip it.",
				requireApproval: true,
				inputSchema: z.object({
					automationId: z.string().min(1),
					deletedBy: z.string().min(1).default("qcp-automation-mcp"),
				}),
				outputSchema: z.object({
					ok: z.boolean(),
					automationId: z.string(),
				}),
				execute: async ({ automationId, deletedBy }) => {
					const registry = getRegistry();
					await registry.ensureSchema();
					await registry.softDeleteAutomation({
						automationId,
						deletedBy: deletedBy ?? "qcp-automation-mcp",
						deletedAt: new Date().toISOString(),
					});
					return {
						ok: true,
						automationId,
					};
				},
			}),
			qcp_run_automation: createTool({
				id: "qcp_run_automation",
				description: "Manually execute an active qcp automation.",
				requireApproval: true,
				inputSchema: z.object({
					automationId: z.string().min(1),
					reason: z.enum(["manual", "test"]).default("manual"),
				}),
				outputSchema: z.object({
					run: AutomationRunRecordSchema,
				}),
				execute: async ({ automationId, reason }) => {
					const registry = getRegistry();
					await registry.ensureSchema();
					const definition = await registry.getDefinition(automationId);
					if (!definition || definition.status !== "active") {
						throw new AutomationRegistryError(
							`Automation is not active: ${automationId}`,
						);
					}
					const run = await registry.recordRunStarted({
						automationId,
						reason: reason ?? "manual",
						startedAt: new Date().toISOString(),
					});
					const output = await executeAutomationDefinition(definition);
					const completed = await registry.recordRunSucceeded(run.id, output);
					return {
						run: completed,
					};
				},
			}),
			qcp_test_heartbeat_automation: createTool({
				id: "qcp_test_heartbeat_automation",
				description:
					"Create, review, approve, run, and delete a heartbeat automation against the registry.",
				requireApproval: true,
				inputSchema: z.object({
					requestedBy: z.string().min(1).default("qcp-automation-mcp"),
				}),
				outputSchema: z.object({
					requestId: z.string(),
					automationId: z.string(),
					run: AutomationRunRecordSchema,
				}),
				execute: async ({ requestedBy }) => {
					const registry = getRegistry();
					const actor = requestedBy ?? "qcp-automation-mcp";
					const query = "Create a heartbeat test automation";
					const mode: AutomationMode = "test";
					const createdAt = new Date().toISOString();
					const requestId = `req_${randomUUID()}`;

					await registry.ensureSchema();
					await registry.upsertRequest({
						requestId,
						query,
						requestedBy: actor,
						mode,
						createdAt,
					});
					await registry.markRequestGenerating(requestId);
					const draft = await agent.createDraft(query, mode);
					await registry.storeReview({
						requestId,
						spec: draft.spec,
						review: draft.review,
						validationIssues: draft.validation.issues,
					});
					await registry.approveRequest({
						requestId,
						approvedBy: actor,
						approvedAt: new Date().toISOString(),
					});
					const definition = await registry.activateRequest(requestId);
					const run = await registry.recordRunStarted({
						automationId: definition.id,
						reason: "test",
						startedAt: new Date().toISOString(),
					});
					const output = await executeAutomationDefinition(definition);
					const completed = await registry.recordRunSucceeded(run.id, output);
					await registry.softDeleteAutomation({
						automationId: definition.id,
						deletedBy: actor,
						deletedAt: new Date().toISOString(),
					});

					return {
						requestId,
						automationId: definition.id,
						run: completed,
					};
				},
			}),
		},
	});
}
