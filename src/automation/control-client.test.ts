import { describe, expect, test } from "bun:test";
import { AutomationControlClient } from "./control-client.js";

describe("automation control client", () => {
	test("submits draft requests with bearer auth", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		const client = new AutomationControlClient({
			baseUrl: "https://automation.example.com/root/",
			token: "secret",
			fetch: async (input, init) => {
				capturedUrl = String(input);
				capturedInit = init;
				return jsonResponse({
					requestId: "req_1",
					status: "queued",
				});
			},
		});

		const response = await client.submitDraft({
			query: "Create a heartbeat",
			requestedBy: "tester",
			mode: "test",
		});

		expect(response.requestId).toBe("req_1");
		expect(capturedUrl).toBe(
			"https://automation.example.com/root/automation/requests",
		);
		expect(capturedInit?.method).toBe("POST");
		expect(headerValue(capturedInit?.headers, "Authorization")).toBe(
			"Bearer secret",
		);
		expect(capturedInit?.body).toContain("Create a heartbeat");
	});

	test("calls delete endpoint for soft deletion", async () => {
		let capturedUrl = "";
		let capturedMethod = "";
		const client = new AutomationControlClient({
			baseUrl: "https://automation.example.com",
			fetch: async (input, init) => {
				capturedUrl = String(input);
				capturedMethod = init?.method ?? "";
				return jsonResponse({
					ok: true,
				});
			},
		});

		const response = await client.delete({
			automationId: "aut_1",
			deletedBy: "tester",
		});

		expect(response.ok).toBe(true);
		expect(capturedMethod).toBe("DELETE");
		expect(capturedUrl).toBe("https://automation.example.com/automation/aut_1");
	});
});

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		headers: {
			"Content-Type": "application/json",
		},
	});
}

function headerValue(
	headers: HeadersInit | undefined,
	name: string,
): string | null {
	if (!headers) return null;
	return new Headers(headers).get(name);
}
