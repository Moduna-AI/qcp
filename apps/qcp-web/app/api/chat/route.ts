import { randomUUID } from "node:crypto";
import { createQcpWebSupervisor } from "@moduna/qcp/web";
import { chatRequestSchema } from "~/lib/api";
import { requireAuthenticated } from "~/lib/auth";
import {
	createApprovalHandler,
	type PendingRun,
	pendingRuns,
	streamDirectText,
	streamError,
	streamMastraOutput,
} from "~/lib/chat-runs";

export async function POST(request: Request): Promise<Response> {
	const unauthorized = await requireAuthenticated();
	if (unauthorized) return unauthorized;

	const parsed = chatRequestSchema.safeParse(
		await request.json().catch(() => ({})),
	);
	if (!parsed.success) {
		return Response.json({ error: "Message is required." }, { status: 400 });
	}

	try {
		const approvedToolCallIds = new Set<string>();
		const session = await createQcpWebSupervisor({
			connectionName: parsed.data.connectionName,
			sessionId: randomUUID(),
			safetyLevel: parsed.data.safetyLevel,
			approvalHandler: createApprovalHandler(approvedToolCallIds),
		});
		const pending: PendingRun = {
			supervisor: session.supervisor,
			approvedToolCallIds,
		};
		const response = await session.supervisor.streamResponse(
			parsed.data.message,
		);
		if (response.direct) {
			return streamDirectText(response.text);
		}
		const runId = response.stream.runId;
		if (runId) pendingRuns.set(runId, pending);
		return streamMastraOutput(response.stream, pending);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return streamError(message);
	}
}
