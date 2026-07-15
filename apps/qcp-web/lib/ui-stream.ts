import {
	parseJsonEventStream,
	readUIMessageStream,
	type UIMessageChunk,
	uiMessageChunkSchema,
} from "ai";
import type { QcpWebUIMessage } from "./api";

export async function readQcpWebUIMessageStream(
	body: ReadableStream<Uint8Array>,
	initialMessage: QcpWebUIMessage,
	onUpdate: (message: QcpWebUIMessage) => void,
): Promise<void> {
	const chunks = parseJsonEventStream({
		stream: body,
		schema: uiMessageChunkSchema,
	}).pipeThrough(
		new TransformStream({
			transform(result, controller): void {
				if (!result.success) throw result.error;
				controller.enqueue(result.value);
			},
		}),
	) as ReadableStream<UIMessageChunk>;

	for await (const message of readUIMessageStream<QcpWebUIMessage>({
		message: initialMessage,
		stream: chunks,
		terminateOnError: true,
	})) {
		onUpdate(message);
	}
}
