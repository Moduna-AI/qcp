import { describe, expect, test } from "bun:test";
import { InMemoryAutomationRegistry } from "./registry.js";
import {
	createAutomationReview,
	createHeartbeatAutomationSpec,
} from "./spec.js";

describe("automation registry approval flow", () => {
	test("requires approval before activation and excludes soft-deleted definitions", async () => {
		const registry = new InMemoryAutomationRegistry();
		const createdAt = "2026-07-01T00:00:00.000Z";
		const spec = createHeartbeatAutomationSpec();

		await registry.ensureSchema();
		await registry.upsertRequest({
			requestId: "req_1",
			query: "Create a heartbeat",
			requestedBy: "tester",
			mode: "test",
			createdAt,
		});
		await registry.markRequestGenerating("req_1");
		await registry.storeReview({
			requestId: "req_1",
			spec,
			review: createAutomationReview(spec),
			validationIssues: [],
		});

		await expect(registry.activateRequest("req_1")).rejects.toThrow(/approved/);

		await registry.approveRequest({
			requestId: "req_1",
			approvedBy: "tester",
			approvedAt: "2026-07-01T00:01:00.000Z",
		});
		const definition = await registry.activateRequest("req_1");
		expect(definition.status).toBe("active");

		const activeList = await registry.listAutomations();
		expect(activeList.map((automation) => automation.id)).toContain(
			definition.id,
		);

		await registry.softDeleteAutomation({
			automationId: definition.id,
			deletedBy: "tester",
			deletedAt: "2026-07-01T00:02:00.000Z",
		});
		const deletedList = await registry.listAutomations();
		expect(deletedList.map((automation) => automation.id)).not.toContain(
			definition.id,
		);
	});
});
