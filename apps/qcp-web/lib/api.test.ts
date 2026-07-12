import { describe, expect, test } from "bun:test";
import {
	approvalRequestSchema,
	chatRequestSchema,
	encodeStreamEvent,
	loginRequestSchema,
	parseStreamEvent,
	safetyConfigRequestSchema,
	setupRequestSchema,
} from "./api";

describe("qcp-web API helpers", () => {
	test("validates auth, chat, and approval request bodies", () => {
		expect(loginRequestSchema.parse({ passcode: " local " }).passcode).toBe(
			"local",
		);
		expect(setupRequestSchema.parse({ passcode: " 1234 " }).passcode).toBe(
			"1234",
		);
		expect(chatRequestSchema.parse({ message: "show tables" }).message).toBe(
			"show tables",
		);
		expect(
			chatRequestSchema.parse({
				message: "show tables",
				safetyLevel: "strict",
			}).safetyLevel,
		).toBe("strict");
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
		expect(() => chatRequestSchema.parse({ message: "" })).toThrow();
		expect(() =>
			safetyConfigRequestSchema.parse({ safetyLevel: "unsafe" }),
		).toThrow();
	});

	test("round-trips stream events", () => {
		const line = encodeStreamEvent({
			type: "approval",
			runId: "run-1",
			toolCallId: "tool-1",
			toolName: "qcp_execute_read_sql",
		}).trim();

		expect(parseStreamEvent(line)).toEqual({
			type: "approval",
			runId: "run-1",
			toolCallId: "tool-1",
			toolName: "qcp_execute_read_sql",
		});
	});
});
