import { describe, expect, test } from "bun:test";
import { getNextRunAt, isAutomationDue } from "./schedule.js";
import { createAutomationReview } from "./spec.js";
import type { AutomationDefinitionRecord, AutomationSpecV1 } from "./types.js";

describe("automation scheduling", () => {
	test("computes the next supported cron run", () => {
		const next = getNextRunAt(
			"*/15 * * * *",
			new Date("2026-07-01T10:07:30.000Z"),
		);

		expect(next?.toISOString()).toBe("2026-07-01T10:15:00.000Z");
	});

	test("detects due active cron automations", () => {
		const spec: AutomationSpecV1 = {
			version: "v1",
			name: "Cron Heartbeat",
			description: "Cron heartbeat test.",
			trigger: {
				type: "cron",
				cron: "*/5 * * * *",
			},
			action: {
				type: "test.heartbeat",
				message: "hello",
			},
			requiredEnvVars: [],
			safety: {
				readOnly: true,
				requiresApproval: true,
			},
		};
		const definition: AutomationDefinitionRecord = {
			id: "aut_1",
			requestId: "req_1",
			name: spec.name,
			status: "active",
			spec,
			review: createAutomationReview(spec),
			createdAt: "2026-07-01T00:00:00.000Z",
			updatedAt: "2026-07-01T00:00:00.000Z",
			nextRunAt: "2026-07-01T10:05:00.000Z",
		};

		expect(
			isAutomationDue(definition, new Date("2026-07-01T10:05:01.000Z")),
		).toBe(true);
		expect(
			isAutomationDue(definition, new Date("2026-07-01T10:04:59.000Z")),
		).toBe(false);
	});
});
