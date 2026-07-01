import { describe, expect, test } from "bun:test";
import type {
	AutomationControlApi,
	DeleteAutomationControlInput,
} from "@/automation/control-client.js";
import { AutomationControlApiError } from "@/automation/errors.js";
import type {
	AutomationListResponse,
	AutomationMutationResponse,
	AutomationStatusResponse,
	SubmitAutomationResponse,
} from "@/automation/types.js";
import {
	automationDeleteCommand,
	automationListCommand,
} from "./automation.js";

describe("automation management commands", () => {
	test("list reads active and draft automations from the control client", async () => {
		const client = new FakeAutomationControlClient();

		await withMutedConsole(async () => {
			await automationListCommand({ client });
		});

		expect(client.listCalled).toBe(true);
	});

	test("delete --yes soft-deletes without prompting", async () => {
		const client = new FakeAutomationControlClient();

		await withMutedConsole(async () => {
			await automationDeleteCommand("aut_1", { yes: true }, { client });
		});

		expect(client.deleted?.automationId).toBe("aut_1");
	});
});

class FakeAutomationControlClient implements AutomationControlApi {
	public listCalled = false;
	public deleted: DeleteAutomationControlInput | null = null;

	public async submitDraft(): Promise<SubmitAutomationResponse> {
		return unsupported();
	}

	public async getStatus(): Promise<AutomationStatusResponse> {
		return unsupported();
	}

	public async approve(): Promise<AutomationMutationResponse> {
		return unsupported();
	}

	public async list(): Promise<AutomationListResponse> {
		this.listCalled = true;
		return {
			automations: [
				{
					id: "aut_1",
					requestId: "req_1",
					name: "Heartbeat",
					status: "active",
					trigger: "Manual trigger only.",
					action: "Send heartbeat output: hello",
				},
			],
		};
	}

	public async delete(
		input: DeleteAutomationControlInput,
	): Promise<AutomationMutationResponse> {
		this.deleted = input;
		return {
			ok: true,
			message: "deleted",
		};
	}

	public async run(): Promise<AutomationMutationResponse> {
		return unsupported();
	}
}

async function unsupported<T>(): Promise<T> {
	throw new AutomationControlApiError("Unexpected fake client call");
}

async function withMutedConsole(fn: () => Promise<void>): Promise<void> {
	const originalLog = console.log;
	const originalError = console.error;
	console.log = () => undefined;
	console.error = () => undefined;

	try {
		await fn();
	} finally {
		console.log = originalLog;
		console.error = originalError;
	}
}
