import { describe, expect, test } from "bun:test";
import {
	createAutomationReview,
	createHeartbeatAutomationSpec,
	validateAutomationSpec,
} from "./spec.js";
import {
	AutomationApprovedEventSchema,
	AutomationDeletedEventSchema,
	AutomationExecuteEventSchema,
	AutomationRequestedEventSchema,
	type AutomationSpecV1,
} from "./types.js";

describe("automation spec validation", () => {
	test("creates a concrete heartbeat review", () => {
		const spec = createHeartbeatAutomationSpec();
		const validation = validateAutomationSpec(spec);
		const review = createAutomationReview(spec, validation.issues);

		expect(validation.valid).toBe(true);
		expect(review.summary).toContain("Heartbeat Test");
		expect(review.trigger).toContain("Manual");
		expect(review.action).toContain("heartbeat");
		expect(review.expectedRunOutput).toContain("timestamped");
	});

	test("enforces secret env refs for read-only qcp ask automations", () => {
		const spec: AutomationSpecV1 = {
			version: "v1",
			name: "Daily Revenue",
			description: "Run a read-only daily revenue question.",
			trigger: {
				type: "cron",
				cron: "0 9 * * *",
			},
			action: {
				type: "qcp.ask.readonly",
				question: "What was revenue yesterday?",
				connectionName: "prod",
				databaseSecretEnv: "prod_url",
				maxRows: 100,
			},
			requiredEnvVars: [],
			safety: {
				readOnly: true,
				requiresApproval: true,
				maxRows: 100,
			},
		};

		const validation = validateAutomationSpec(spec);

		expect(validation.valid).toBe(false);
		expect(validation.issues).toContain(
			"Invalid database secret reference: prod_url",
		);
		expect(validation.issues).toContain(
			"Database secret reference prod_url must be listed in requiredEnvVars.",
		);
	});

	test("validates automation event payloads", () => {
		const createdAt = "2026-07-01T00:00:00.000Z";

		expect(
			AutomationRequestedEventSchema.parse({
				requestId: "req_1",
				query: "Create a heartbeat",
				requestedBy: "tester",
				mode: "test",
				createdAt,
			}).mode,
		).toBe("test");
		expect(
			AutomationApprovedEventSchema.parse({
				requestId: "req_1",
				approvedBy: "tester",
				approvedAt: createdAt,
			}).requestId,
		).toBe("req_1");
		expect(
			AutomationDeletedEventSchema.parse({
				automationId: "aut_1",
				deletedBy: "tester",
				deletedAt: createdAt,
			}).automationId,
		).toBe("aut_1");
		expect(
			AutomationExecuteEventSchema.parse({
				automationId: "aut_1",
				requestedBy: "tester",
				requestedAt: createdAt,
				runReason: "manual",
			}).runReason,
		).toBe("manual");
	});
});
