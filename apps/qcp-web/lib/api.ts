import { z } from "zod";

export const SESSION_COOKIE = "qcp_web_session";

export const loginRequestSchema = z.object({
	passcode: z.string().trim().min(1),
});

export const setupRequestSchema = z.object({
	passcode: z.string().trim().regex(/^\d{4}$/),
});

export const chatRequestSchema = z.object({
	message: z.string().min(1),
	connectionName: z.string().min(1).optional(),
});

export const approvalRequestSchema = z.object({
	runId: z.string().min(1),
	toolCallId: z.string().min(1).optional(),
	approve: z.boolean().optional(),
});

export interface StreamTextEvent {
	readonly type: "text";
	readonly text: string;
}

export interface StreamApprovalEvent {
	readonly type: "approval";
	readonly runId: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly args?: unknown;
}

export interface StreamErrorEvent {
	readonly type: "error";
	readonly error: string;
}

export interface StreamDoneEvent {
	readonly type: "done";
}

export type QcpWebStreamEvent =
	| StreamTextEvent
	| StreamApprovalEvent
	| StreamErrorEvent
	| StreamDoneEvent;

export function encodeStreamEvent(event: QcpWebStreamEvent): string {
	return `data: ${JSON.stringify(event)}\n\n`;
}

export function parseStreamEvent(line: string): QcpWebStreamEvent | undefined {
	if (!line.startsWith("data: ")) return undefined;
	return z
		.discriminatedUnion("type", [
			z.object({ type: z.literal("text"), text: z.string() }),
			z.object({
				type: z.literal("approval"),
				runId: z.string(),
				toolCallId: z.string().optional(),
				toolName: z.string().optional(),
				args: z.unknown().optional(),
			}),
			z.object({ type: z.literal("error"), error: z.string() }),
			z.object({ type: z.literal("done") }),
		])
		.parse(JSON.parse(line.slice("data: ".length)));
}
