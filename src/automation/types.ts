import { z } from "zod";

export const AUTOMATION_SPEC_VERSION = "v1";

export const AUTOMATION_EVENT_NAMES = {
	requested: "qcp/automation.requested",
	reviewed: "qcp/automation.reviewed",
	approved: "qcp/automation.approved",
	deleted: "qcp/automation.deleted",
	execute: "qcp/automation.execute",
} as const;

export const AutomationTriggerSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("manual"),
	}),
	z.object({
		type: z.literal("cron"),
		cron: z.string().min(1),
		timezone: z.string().min(1).optional(),
	}),
]);

export const AutomationActionSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("test.heartbeat"),
		message: z.string().min(1).default("qcp automation heartbeat"),
	}),
	z.object({
		type: z.literal("qcp.ask.readonly"),
		question: z.string().min(1),
		connectionName: z.string().min(1),
		databaseSecretEnv: z.string().min(1),
		maxRows: z.number().int().positive().max(500).default(100),
	}),
]);

export const AutomationSafetySchema = z.object({
	readOnly: z.literal(true),
	requiresApproval: z.literal(true),
	maxRows: z.number().int().positive().max(500).optional(),
});

export const AutomationSpecV1Schema = z.object({
	version: z.literal(AUTOMATION_SPEC_VERSION),
	name: z.string().min(1).max(80),
	description: z.string().min(1).max(500),
	trigger: AutomationTriggerSchema,
	action: AutomationActionSchema,
	requiredEnvVars: z.array(z.string().min(1)).default([]),
	safety: AutomationSafetySchema,
});

export const AutomationReviewSchema = z.object({
	summary: z.string().min(1),
	trigger: z.string().min(1),
	action: z.string().min(1),
	requiredEnvVars: z.array(z.string()),
	safety: z.array(z.string()),
	expectedRunOutput: z.string().min(1),
	validationIssues: z.array(z.string()),
});

export const AutomationModeSchema = z.enum(["production", "test"]);

export const AutomationRequestStatusSchema = z.enum([
	"queued",
	"generating",
	"awaiting_approval",
	"approved",
	"active",
	"failed",
	"expired",
	"deleted",
]);

export const AutomationDefinitionStatusSchema = z.enum(["active", "deleted"]);

export const AutomationRunStatusSchema = z.enum([
	"queued",
	"running",
	"succeeded",
	"failed",
	"skipped",
]);

export const AutomationRequestedEventSchema = z.object({
	requestId: z.string().min(1),
	query: z.string().min(1),
	requestedBy: z.string().min(1),
	mode: AutomationModeSchema.default("production"),
	createdAt: z.string().datetime(),
});

export const AutomationReviewedEventSchema = z.object({
	requestId: z.string().min(1),
	review: AutomationReviewSchema,
	reviewedAt: z.string().datetime(),
});

export const AutomationApprovedEventSchema = z.object({
	requestId: z.string().min(1),
	approvedBy: z.string().min(1),
	approvedAt: z.string().datetime(),
});

export const AutomationDeletedEventSchema = z.object({
	automationId: z.string().min(1),
	deletedBy: z.string().min(1),
	deletedAt: z.string().datetime(),
});

export const AutomationExecuteEventSchema = z.object({
	automationId: z.string().min(1),
	requestedBy: z.string().min(1),
	requestedAt: z.string().datetime(),
	runReason: z.enum(["manual", "cron", "test"]),
});

export const AutomationRequestRecordSchema = z.object({
	id: z.string().min(1),
	query: z.string().min(1),
	requestedBy: z.string().min(1),
	status: AutomationRequestStatusSchema,
	mode: AutomationModeSchema,
	spec: AutomationSpecV1Schema.optional(),
	review: AutomationReviewSchema.optional(),
	validationIssues: z.array(z.string()).default([]),
	automationId: z.string().min(1).optional(),
	error: z.string().optional(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
	approvedAt: z.string().datetime().optional(),
	approvedBy: z.string().optional(),
});

export const AutomationDefinitionRecordSchema = z.object({
	id: z.string().min(1),
	requestId: z.string().min(1),
	name: z.string().min(1),
	status: AutomationDefinitionStatusSchema,
	spec: AutomationSpecV1Schema,
	review: AutomationReviewSchema,
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
	nextRunAt: z.string().datetime().optional(),
	lastRunAt: z.string().datetime().optional(),
	deletedAt: z.string().datetime().optional(),
	deletedBy: z.string().optional(),
});

export const AutomationRunRecordSchema = z.object({
	id: z.string().min(1),
	automationId: z.string().min(1),
	status: AutomationRunStatusSchema,
	reason: z.enum(["manual", "cron", "test"]),
	startedAt: z.string().datetime(),
	completedAt: z.string().datetime().optional(),
	output: z.record(z.string(), z.unknown()).optional(),
	error: z.string().optional(),
});

export const AutomationListItemSchema = z.object({
	id: z.string().min(1),
	requestId: z.string().min(1).optional(),
	name: z.string().min(1),
	status: z.union([
		AutomationRequestStatusSchema,
		AutomationDefinitionStatusSchema,
	]),
	trigger: z.string().min(1),
	action: z.string().min(1),
	lastRunAt: z.string().datetime().optional(),
	nextRunAt: z.string().datetime().optional(),
});

export const SubmitAutomationResponseSchema = z.object({
	requestId: z.string().min(1),
	status: AutomationRequestStatusSchema,
	eventIds: z.array(z.string()).optional(),
	statusUrl: z.string().url().optional(),
});

export const AutomationStatusResponseSchema = z.object({
	request: AutomationRequestRecordSchema,
	definition: AutomationDefinitionRecordSchema.optional(),
	latestRun: AutomationRunRecordSchema.optional(),
});

export const AutomationListResponseSchema = z.object({
	automations: z.array(AutomationListItemSchema),
});

export const AutomationMutationResponseSchema = z.object({
	ok: z.boolean(),
	message: z.string().optional(),
	request: AutomationRequestRecordSchema.optional(),
	definition: AutomationDefinitionRecordSchema.optional(),
	run: AutomationRunRecordSchema.optional(),
});

export type AutomationTrigger = z.infer<typeof AutomationTriggerSchema>;
export type AutomationAction = z.infer<typeof AutomationActionSchema>;
export type AutomationSafety = z.infer<typeof AutomationSafetySchema>;
export type AutomationSpecV1 = z.infer<typeof AutomationSpecV1Schema>;
export type AutomationReview = z.infer<typeof AutomationReviewSchema>;
export type AutomationMode = z.infer<typeof AutomationModeSchema>;
export type AutomationRequestStatus = z.infer<
	typeof AutomationRequestStatusSchema
>;
export type AutomationDefinitionStatus = z.infer<
	typeof AutomationDefinitionStatusSchema
>;
export type AutomationRunStatus = z.infer<typeof AutomationRunStatusSchema>;
export type AutomationRequestedEvent = z.infer<
	typeof AutomationRequestedEventSchema
>;
export type AutomationReviewedEvent = z.infer<
	typeof AutomationReviewedEventSchema
>;
export type AutomationApprovedEvent = z.infer<
	typeof AutomationApprovedEventSchema
>;
export type AutomationDeletedEvent = z.infer<
	typeof AutomationDeletedEventSchema
>;
export type AutomationExecuteEvent = z.infer<
	typeof AutomationExecuteEventSchema
>;
export type AutomationRequestRecord = z.infer<
	typeof AutomationRequestRecordSchema
>;
export type AutomationDefinitionRecord = z.infer<
	typeof AutomationDefinitionRecordSchema
>;
export type AutomationRunRecord = z.infer<typeof AutomationRunRecordSchema>;
export type AutomationListItem = z.infer<typeof AutomationListItemSchema>;
export type SubmitAutomationResponse = z.infer<
	typeof SubmitAutomationResponseSchema
>;
export type AutomationStatusResponse = z.infer<
	typeof AutomationStatusResponseSchema
>;
export type AutomationListResponse = z.infer<
	typeof AutomationListResponseSchema
>;
export type AutomationMutationResponse = z.infer<
	typeof AutomationMutationResponseSchema
>;

export const AUTOMATION_SPEC_OUTPUT_SCHEMA = {
	type: "object",
	properties: {
		version: { const: AUTOMATION_SPEC_VERSION },
		name: { type: "string" },
		description: { type: "string" },
		trigger: {
			oneOf: [
				{
					type: "object",
					properties: { type: { const: "manual" } },
					required: ["type"],
					additionalProperties: false,
				},
				{
					type: "object",
					properties: {
						type: { const: "cron" },
						cron: { type: "string" },
						timezone: { type: "string" },
					},
					required: ["type", "cron"],
					additionalProperties: false,
				},
			],
		},
		action: {
			oneOf: [
				{
					type: "object",
					properties: {
						type: { const: "test.heartbeat" },
						message: { type: "string" },
					},
					required: ["type", "message"],
					additionalProperties: false,
				},
				{
					type: "object",
					properties: {
						type: { const: "qcp.ask.readonly" },
						question: { type: "string" },
						connectionName: { type: "string" },
						databaseSecretEnv: { type: "string" },
						maxRows: { type: "integer", minimum: 1, maximum: 500 },
					},
					required: [
						"type",
						"question",
						"connectionName",
						"databaseSecretEnv",
						"maxRows",
					],
					additionalProperties: false,
				},
			],
		},
		requiredEnvVars: {
			type: "array",
			items: { type: "string" },
		},
		safety: {
			type: "object",
			properties: {
				readOnly: { const: true },
				requiresApproval: { const: true },
				maxRows: { type: "integer", minimum: 1, maximum: 500 },
			},
			required: ["readOnly", "requiresApproval"],
			additionalProperties: false,
		},
	},
	required: [
		"version",
		"name",
		"description",
		"trigger",
		"action",
		"requiredEnvVars",
		"safety",
	],
	additionalProperties: false,
} as const;
