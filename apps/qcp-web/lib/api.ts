import type { UIMessage } from "ai";
import { z } from "zod";
import { type QcpChartSpec, qcpWebChartSpecSchema } from "./chart-contract";

export const SESSION_COOKIE = "qcp_web_session";

export const loginRequestSchema = z.object({
	passcode: z.string().trim().min(1),
});

export const setupRequestSchema = z.object({
	passcode: z
		.string()
		.trim()
		.regex(/^\d{4}$/),
});

export const safetyLevelSchema = z.enum(["low", "standard", "strict"]);

const qcpWebMessageSchema = z.object({
	id: z.string().min(1),
	role: z.enum(["system", "user", "assistant"]),
	parts: z.array(z.unknown()),
});

export const chatRequestSchema = z.object({
	messages: z.array(qcpWebMessageSchema).min(1),
	connectionName: z.string().min(1).optional(),
	safetyLevel: safetyLevelSchema.optional(),
});

export const safetyConfigRequestSchema = z.object({
	safetyLevel: safetyLevelSchema,
	passcode: z.string().trim().min(1).optional(),
});

export const approvalRequestSchema = z.object({
	runId: z.string().min(1),
	toolCallId: z.string().min(1).optional(),
	approve: z.boolean().optional(),
});

export const qcpWebApprovalDataSchema = z.object({
	runId: z.string().min(1),
	toolCallId: z.string().optional(),
	toolName: z.string().optional(),
	args: z.unknown().optional(),
});

export interface QcpWebApprovalData {
	readonly runId: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly args?: unknown;
}

export type QcpWebDataParts = {
	chart: QcpChartSpec;
	approval: QcpWebApprovalData;
};

export type QcpWebUIMessage = UIMessage<unknown, QcpWebDataParts>;

export const qcpWebDataPartSchemas = {
	chart: qcpWebChartSpecSchema,
	approval: qcpWebApprovalDataSchema,
};

export function getLatestUserText(
	messages: readonly z.infer<typeof qcpWebMessageSchema>[],
): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "user") continue;
		const text = message.parts
			.map((part) => {
				if (!isRecord(part) || part.type !== "text") return "";
				return typeof part.text === "string" ? part.text : "";
			})
			.join("")
			.trim();
		if (text) return text;
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}
