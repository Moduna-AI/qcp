import type { QcpSupervisorAgent } from "@moduna/qcp/web";
import { encodeStreamEvent } from "./api";

export interface PendingRun {
	readonly supervisor: QcpSupervisorAgent;
	readonly approvedToolCallIds: Set<string>;
}

declare global {
	var qcpWebPendingRuns: Map<string, PendingRun> | undefined;
}

export const pendingRuns =
	globalThis.qcpWebPendingRuns ?? new Map<string, PendingRun>();

globalThis.qcpWebPendingRuns = pendingRuns;

export function createApprovalHandler(
	approvedToolCallIds: Set<string>,
): () => Promise<boolean> {
	return async () => {
		const [toolCallId] = approvedToolCallIds;
		if (!toolCallId) return false;
		approvedToolCallIds.delete(toolCallId);
		return true;
	};
}

export function streamHeaders(): HeadersInit {
	return {
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"Content-Type": "text/event-stream; charset=utf-8",
	};
}

export function streamDirectText(text: string): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				writeEvent(controller, { type: "text", text });
				writeEvent(controller, { type: "done" });
				controller.close();
			},
		}),
		{ headers: streamHeaders() },
	);
}

export function streamError(error: string, status = 200): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				writeEvent(controller, { type: "error", error });
				writeEvent(controller, { type: "done" });
				controller.close();
			},
		}),
		{ headers: streamHeaders(), status },
	);
}

export function streamMastraOutput(
	output: {
		readonly fullStream?: AsyncIterable<unknown>;
		readonly textStream?: AsyncIterable<string>;
		readonly runId?: string;
	},
	pending: PendingRun,
): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			async start(controller) {
				try {
					if (output.fullStream) {
						await streamFullOutput(
							controller,
							output.fullStream,
							output.runId,
							pending,
						);
					} else if (output.textStream) {
						for await (const chunk of output.textStream) {
							writeEvent(controller, { type: "text", text: chunk });
						}
					}
					writeEvent(controller, { type: "done" });
				} catch (error: unknown) {
					const message =
						error instanceof Error ? error.message : String(error);
					writeEvent(controller, { type: "error", error: message });
					writeEvent(controller, { type: "done" });
				} finally {
					controller.close();
				}
			},
		}),
		{ headers: streamHeaders() },
	);
}

async function streamFullOutput(
	controller: ReadableStreamDefaultController<Uint8Array>,
	fullStream: AsyncIterable<unknown>,
	runId: string | undefined,
	pending: PendingRun,
): Promise<void> {
	for await (const chunk of fullStream) {
		const type = getChunkType(chunk);
		if (type === "text-delta") {
			const text = getChunkText(chunk);
			if (text) writeEvent(controller, { type: "text", text });
			continue;
		}
		if (type === "tool-call-approval") {
			const approval = getApprovalPayload(chunk);
			const effectiveRunId = runId ?? approval.runId;
			if (effectiveRunId) {
				pendingRuns.set(effectiveRunId, pending);
				writeEvent(controller, {
					type: "approval",
					runId: effectiveRunId,
					toolCallId: approval.toolCallId,
					toolName: approval.toolName,
					args: approval.args,
				});
			}
		}
	}
}

function writeEvent(
	controller: ReadableStreamDefaultController<Uint8Array>,
	event: Parameters<typeof encodeStreamEvent>[0],
): void {
	controller.enqueue(new TextEncoder().encode(encodeStreamEvent(event)));
}

function getChunkType(chunk: unknown): string | undefined {
	if (!isRecord(chunk)) return undefined;
	return typeof chunk.type === "string" ? chunk.type : undefined;
}

function getChunkText(chunk: unknown): string | undefined {
	if (!isRecord(chunk)) return undefined;
	if (typeof chunk.text === "string") return chunk.text;
	if (typeof chunk.textDelta === "string") return chunk.textDelta;
	if (isRecord(chunk.payload)) {
		if (typeof chunk.payload.text === "string") return chunk.payload.text;
		if (typeof chunk.payload.textDelta === "string")
			return chunk.payload.textDelta;
	}
	return undefined;
}

function getApprovalPayload(chunk: unknown): {
	readonly runId?: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly args?: unknown;
} {
	if (!isRecord(chunk)) return {};
	const payload = isRecord(chunk.payload) ? chunk.payload : chunk;
	return {
		runId: typeof payload.runId === "string" ? payload.runId : undefined,
		toolCallId:
			typeof payload.toolCallId === "string" ? payload.toolCallId : undefined,
		toolName:
			typeof payload.toolName === "string" ? payload.toolName : undefined,
		args: "args" in payload ? payload.args : undefined,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}
