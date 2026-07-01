import {
	desktopApprovalRequestSchema,
	desktopAssistantRequestSchema,
	desktopRunnerRequestSchema,
	runDesktopCommand,
} from "./assistant-runtime.js";

async function readStdin(): Promise<string> {
	const chunks: Uint8Array[] = [];

	for await (const chunk of Bun.stdin.stream()) {
		chunks.push(chunk);
	}

	return new TextDecoder().decode(Buffer.concat(chunks));
}

async function main(): Promise<void> {
	const rawInput = await readStdin();
	const parsedJson: unknown = JSON.parse(rawInput);
	const request = parseRunnerRequest(parsedJson);
	const response = await runDesktopCommand(request);
	process.stdout.write(`${JSON.stringify(response)}\n`);
}

function parseRunnerRequest(
	parsedJson: unknown,
): ReturnType<typeof desktopRunnerRequestSchema.parse> {
	const commandResult = desktopRunnerRequestSchema.safeParse(parsedJson);
	if (commandResult.success) return commandResult.data;

	const legacySubmitResult =
		desktopAssistantRequestSchema.safeParse(parsedJson);
	if (legacySubmitResult.success) {
		return {
			command: "submitPrompt",
			request: legacySubmitResult.data,
		};
	}

	const legacyApprovalResult =
		desktopApprovalRequestSchema.safeParse(parsedJson);
	if (legacyApprovalResult.success) {
		return {
			command: "approvePrompt",
			request: legacyApprovalResult.data,
		};
	}

	return desktopRunnerRequestSchema.parse(parsedJson);
}

main().catch((err: unknown) => {
	const message = err instanceof Error ? err.message : String(err);
	const response = {
		status: "error" as const,
		code: "assistant_failed" as const,
		message: "Assistant response failed.",
		detail: message,
	};
	process.stdout.write(`${JSON.stringify(response)}\n`);
	process.exitCode = 1;
});
