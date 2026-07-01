import { describe, expect, test } from "bun:test";
import {
	QcpAutomationAgent,
	type AutomationSpecGenerator,
	type GenerateAutomationSpecInput,
} from "./automation-agent.js";
import { createHeartbeatAutomationSpec } from "@/automation/spec.js";
import type { AutomationSpecV1 } from "@/automation/types.js";

class MockAutomationSpecGenerator implements AutomationSpecGenerator {
	public lastInput: GenerateAutomationSpecInput | null = null;

	public async generateSpec(
		input: GenerateAutomationSpecInput,
	): Promise<AutomationSpecV1> {
		this.lastInput = input;
		return createHeartbeatAutomationSpec();
	}
}

describe("qcp automation agent", () => {
	test("runs multi-step draft generation in test mode", async () => {
		const generator = new MockAutomationSpecGenerator();
		const agent = new QcpAutomationAgent({ generator });

		const draft = await agent.createDraft(
			"Create a heartbeat test automation",
			"test",
		);

		expect(generator.lastInput?.mode).toBe("test");
		expect(generator.lastInput?.intent.actionHint).toBe("test.heartbeat");
		expect(draft.validation.valid).toBe(true);
		expect(draft.review.summary).toContain("Heartbeat Test");
	});
});
