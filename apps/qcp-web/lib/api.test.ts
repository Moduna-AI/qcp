import { describe, expect, test } from "bun:test";
import {
	approvalRequestSchema,
	chatRequestSchema,
	getLatestUserText,
	loginRequestSchema,
	qcpWebDataPartSchemas,
	safetyConfigRequestSchema,
	setupRequestSchema,
} from "./api";

describe("qcp-web API helpers", () => {
	test("validates auth, AI SDK chat, and approval request bodies", () => {
		expect(loginRequestSchema.parse({ passcode: " local " }).passcode).toBe(
			"local",
		);
		expect(setupRequestSchema.parse({ passcode: " 1234 " }).passcode).toBe(
			"1234",
		);
		const request = chatRequestSchema.parse({
			messages: [userMessage("show tables")],
			safetyLevel: "strict",
		});
		expect(getLatestUserText(request.messages)).toBe("show tables");
		expect(request.safetyLevel).toBe("strict");
		expect(
			safetyConfigRequestSchema.parse({ safetyLevel: "low" }).safetyLevel,
		).toBe("low");
		expect(
			safetyConfigRequestSchema.parse({
				safetyLevel: "low",
				passcode: " 1234 ",
			}).passcode,
		).toBe("1234");
		expect(
			approvalRequestSchema.parse({ runId: "run", toolCallId: "tool" }).runId,
		).toBe("run");
		expect(() => setupRequestSchema.parse({ passcode: "123" })).toThrow();
		expect(() => setupRequestSchema.parse({ passcode: "12345" })).toThrow();
		expect(() => setupRequestSchema.parse({ passcode: "abcd" })).toThrow();
		expect(() => chatRequestSchema.parse({ messages: [] })).toThrow();
		expect(() =>
			safetyConfigRequestSchema.parse({ safetyLevel: "unsafe" }),
		).toThrow();
	});

	test("uses only the newest user text and ignores assistant data parts", () => {
		const messages = [
			userMessage("old question"),
			{
				id: "assistant-1",
				role: "assistant" as const,
				parts: [{ type: "data-chart", data: { sensitive: true } }],
			},
			userMessage("new question"),
		];

		expect(getLatestUserText(messages)).toBe("new question");
	});

	test("validates persistent chart data parts", () => {
		const chart = qcpWebDataPartSchemas.chart.parse({
			version: 1,
			type: "bar",
			title: "Tracks by genre",
			xKey: "genre",
			series: [{ key: "tracks", label: "Tracks" }],
			data: [{ genre: "Rock", tracks: 100 }],
		});

		expect(chart.type).toBe("bar");
		expect(qcpWebDataPartSchemas.approval.parse({ runId: "run-1" }).runId).toBe(
			"run-1",
		);
	});
});

function userMessage(text: string): {
	id: string;
	role: "user";
	parts: Array<{ type: "text"; text: string }>;
} {
	return {
		id: crypto.randomUUID(),
		role: "user",
		parts: [{ type: "text", text }],
	};
}
