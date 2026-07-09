import { approvalRequestSchema } from "~/lib/api";
import { requireAuthenticated } from "~/lib/auth";
import { pendingRuns, streamError, streamMastraOutput } from "~/lib/chat-runs";

export async function POST(request: Request): Promise<Response> {
	return handleApprovalRequest(request, true);
}

export async function handleApprovalRequest(
	request: Request,
	defaultApprove: boolean,
): Promise<Response> {
	const unauthorized = await requireAuthenticated();
	if (unauthorized) return unauthorized;

	const parsed = approvalRequestSchema.safeParse(
		await request.json().catch(() => ({})),
	);
	if (!parsed.success) {
		return Response.json({ error: "runId is required." }, { status: 400 });
	}

	const pending = pendingRuns.get(parsed.data.runId);
	if (!pending) {
		return streamError("Pending approval run not found.", 404);
	}

	try {
		const shouldApprove = parsed.data.approve ?? defaultApprove;
		if (shouldApprove && parsed.data.toolCallId) {
			pending.approvedToolCallIds.add(parsed.data.toolCallId);
		}
		const stream = shouldApprove
			? await pending.supervisor.getAgent().approveToolCall({
					runId: parsed.data.runId,
					toolCallId: parsed.data.toolCallId,
				})
			: await pending.supervisor.getAgent().declineToolCall({
					runId: parsed.data.runId,
					toolCallId: parsed.data.toolCallId,
				});
		return streamMastraOutput(stream, pending);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return streamError(message);
	}
}
