import { toAISdkStream } from "@mastra/ai-sdk";
import type { MastraModelOutput } from "@mastra/core/stream";
import type { QcpSupervisorAgent } from "@moduna/qcp/web";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import type { QcpWebApprovalData, QcpWebUIMessage } from "./api";
import { type QcpChartSpec, qcpWebChartResultSchema } from "./chart-contract";

const QCP_CHART_TOOL_ID = "qcp_render_chart";

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

export function streamDirectText(text: string): Response {
	return createQcpStreamResponse((writer) => {
		const id = "qcp-direct-text";
		writer.write({ type: "text-start", id });
		writer.write({ type: "text-delta", id, delta: text });
		writer.write({ type: "text-end", id });
		writer.write({ type: "finish", finishReason: "stop" });
	});
}

export function streamError(error: string, status = 200): Response {
	return createQcpStreamResponse((writer) => {
		writer.write({ type: "error", errorText: error });
		writer.write({ type: "finish", finishReason: "error" });
	}, status);
}

export function streamMastraOutput<TOutput>(
	output: MastraModelOutput<TOutput>,
	pending: PendingRun,
): Response {
	return createQcpStreamResponse(async (writer) => {
		let emittedChart = false;
		let emittedFinish = false;
		const stream = toAISdkStream(output, {
			from: "agent",
			version: "v6",
			onError: () => "Assistant request failed.",
		});

		for await (const part of stream) {
			if (!isRecord(part) || typeof part.type !== "string") continue;
			const chunk = allowlistedChunk(part);
			if (chunk) {
				writer.write(chunk);
				if (chunk.type === "finish") emittedFinish = true;
			}

			if (part.type === "data-tool-call-approval") {
				const approval = parseApprovalData(part.data);
				if (approval) {
					pendingRuns.set(approval.runId, pending);
					writer.write({
						type: "data-approval",
						id: approval.toolCallId ?? approval.runId,
						data: approval,
					});
				}
			}

			if (part.type === "data-tool-agent") {
				for (const chartResult of extractChartResults(part.data)) {
					if (emittedChart) break;
					emittedChart = true;
					writer.write({
						type: "data-chart",
						id: chartResult.toolCallId,
						data: chartResult.chart,
					});
				}
			}
		}

		if (!emittedFinish) {
			writer.write({ type: "finish", finishReason: "stop" });
		}
	});
}

type QcpStreamWriter = Parameters<
	Parameters<typeof createUIMessageStream<QcpWebUIMessage>>[0]["execute"]
>[0]["writer"];

type QcpWebChunk = Parameters<QcpStreamWriter["write"]>[0];

function createQcpStreamResponse(
	execute: (writer: QcpStreamWriter) => Promise<void> | void,
	status = 200,
): Response {
	const stream = createUIMessageStream<QcpWebUIMessage>({
		execute: ({ writer }) => execute(writer),
		onError: () => "Assistant request failed.",
	});
	return createUIMessageStreamResponse({ stream, status });
}

function allowlistedChunk(
	part: Record<string, unknown>,
): QcpWebChunk | undefined {
	switch (part.type) {
		case "text-start":
			return typeof part.id === "string"
				? { type: "text-start", id: part.id }
				: undefined;
		case "text-delta":
			return typeof part.id === "string" && typeof part.delta === "string"
				? { type: "text-delta", id: part.id, delta: part.delta }
				: undefined;
		case "text-end":
			return typeof part.id === "string"
				? { type: "text-end", id: part.id }
				: undefined;
		case "start-step":
			return { type: "start-step" };
		case "finish-step":
			return { type: "finish-step" };
		case "finish":
			return {
				type: "finish",
				finishReason: normalizeFinishReason(part.finishReason),
			};
		case "error":
			return {
				type: "error",
				errorText:
					typeof part.errorText === "string"
						? part.errorText
						: "Assistant request failed.",
			};
		default:
			return undefined;
	}
}

function normalizeFinishReason(
	value: unknown,
): "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other" {
	return value === "stop" ||
		value === "length" ||
		value === "content-filter" ||
		value === "tool-calls" ||
		value === "error" ||
		value === "other"
		? value
		: "other";
}

function parseApprovalData(value: unknown): QcpWebApprovalData | undefined {
	if (!isRecord(value) || typeof value.runId !== "string") return undefined;
	return {
		runId: value.runId,
		toolCallId:
			typeof value.toolCallId === "string" ? value.toolCallId : undefined,
		toolName: typeof value.toolName === "string" ? value.toolName : undefined,
		args: redactApprovalArgs(value.args),
	};
}

function redactApprovalArgs(
	value: unknown,
): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const redacted: Record<string, string> = {};
	for (const key of Object.keys(value)) {
		redacted[key] =
			key.toLowerCase() === "sql" ? "[REDACTED_SQL]" : "[REDACTED]";
	}
	return redacted;
}

export function extractChartResults(value: unknown): Array<{
	readonly toolCallId: string;
	readonly chart: QcpChartSpec;
}> {
	if (!isRecord(value)) return [];
	const toolResults: unknown[] = [];
	collectToolResults(value.toolResults, toolResults);
	if (Array.isArray(value.steps)) {
		for (const step of value.steps) {
			if (!isRecord(step)) continue;
			collectToolResults(step.toolResults, toolResults);
			collectToolResults(step.staticToolResults, toolResults);
		}
	}

	const charts: Array<{ toolCallId: string; chart: QcpChartSpec }> = [];
	for (const candidate of toolResults) {
		if (!isRecord(candidate) || candidate.toolName !== QCP_CHART_TOOL_ID)
			continue;
		const result = qcpWebChartResultSchema.safeParse(candidate.result);
		if (!result.success || !result.data.ok) continue;
		charts.push({
			toolCallId:
				typeof candidate.toolCallId === "string"
					? candidate.toolCallId
					: `chart-${charts.length + 1}`,
			chart: result.data.chart,
		});
	}
	return charts;
}

function collectToolResults(value: unknown, output: unknown[]): void {
	if (Array.isArray(value)) output.push(...value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}
