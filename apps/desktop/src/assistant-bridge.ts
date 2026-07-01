import { invoke } from '@tauri-apps/api/core'
import { z } from 'zod'

const approvalReasonSchema = z.object({
	type: z.enum(['sensitive_table', 'large_scan', 'no_limit', 'high_cost']),
	detail: z.string(),
})

const assistantSuccessSchema = z.object({
	status: z.literal('success'),
	text: z.string(),
	direct: z.boolean(),
	latencyMs: z.number(),
	tokensIn: z.number().optional(),
	tokensOut: z.number().optional(),
	connectionName: z.string(),
	databaseName: z.string(),
	tableCount: z.number(),
	provider: z.string(),
	model: z.string(),
})

const assistantNeedsApprovalSchema = z.object({
	status: z.literal('needsApproval'),
	requestId: z.string(),
	originalPrompt: z.string(),
	reasons: z.array(approvalReasonSchema),
	sql: z.string(),
	message: z.string(),
	connectionName: z.string(),
})

const assistantErrorSchema = z.object({
	status: z.literal('error'),
	code: z.enum([
		'missing_connection',
		'missing_schema',
		'prompt_violation',
		'approval_mismatch',
		'assistant_failed',
	]),
	message: z.string(),
	detail: z.string().optional(),
})

export const assistantBridgeResponseSchema = z.discriminatedUnion('status', [
	assistantSuccessSchema,
	assistantNeedsApprovalSchema,
	assistantErrorSchema,
])

const settingsSchemaStatusSchema = z.discriminatedUnion('status', [
	z.object({
		status: z.literal('ready'),
		databaseName: z.string(),
		tableCount: z.number(),
		scannedAt: z.string(),
	}),
	z.object({
		status: z.literal('missing'),
		message: z.string(),
		command: z.string(),
	}),
	z.object({
		status: z.literal('error'),
		message: z.string(),
		command: z.string(),
	}),
])

export const desktopSettingsResponseSchema = z.object({
	status: z.enum(['ready', 'missing_connection', 'missing_schema', 'error']),
	appVersion: z.string(),
	runtimeMode: z.enum(['sidecar', 'bun', 'unknown']),
	activeConnection: z
		.object({
			id: z.string(),
			name: z.string(),
			databaseType: z.string(),
		})
		.optional(),
	schema: settingsSchemaStatusSchema,
	provider: z.object({
		name: z.string(),
		model: z.string(),
	}),
	safeMode: z.boolean(),
	telemetry: z.boolean(),
})

export type AssistantBridgeResponse = z.infer<
	typeof assistantBridgeResponseSchema
>

export type AssistantApprovalRequest = Extract<
	AssistantBridgeResponse,
	{ status: 'needsApproval' }
>

export type DesktopSettingsResponse = z.infer<
	typeof desktopSettingsResponseSchema
>

export async function submitAssistantPrompt(
	prompt: string,
	sessionId: string,
): Promise<AssistantBridgeResponse> {
	if (!isTauriRuntime()) return bridgeUnavailableResponse()

	try {
		const response: unknown = await invoke('submit_prompt', {
			prompt,
			sessionId,
		})
		return assistantBridgeResponseSchema.parse(response)
	} catch (err: unknown) {
		return bridgeErrorResponse(err)
	}
}

export async function approveAssistantPrompt(
	approval: AssistantApprovalRequest,
	sessionId: string,
): Promise<AssistantBridgeResponse> {
	if (!isTauriRuntime()) return bridgeUnavailableResponse()

	try {
		const response: unknown = await invoke('approve_prompt', {
			originalPrompt: approval.originalPrompt,
			approvedSql: approval.sql,
			approvedRequestId: approval.requestId,
			sessionId,
		})
		return assistantBridgeResponseSchema.parse(response)
	} catch (err: unknown) {
		return bridgeErrorResponse(err)
	}
}

export async function getDesktopSettings(): Promise<DesktopSettingsResponse> {
	if (!isTauriRuntime()) {
		return {
			status: 'error',
			appVersion: 'dev',
			runtimeMode: 'unknown',
			schema: {
				status: 'error',
				message: 'Desktop bridge is unavailable.',
				command: 'bun run desktop:dev',
			},
			provider: {
				name: 'unknown',
				model: 'unknown',
			},
			safeMode: true,
			telemetry: false,
		}
	}

	const response: unknown = await invoke('get_settings')
	return desktopSettingsResponseSchema.parse(response)
}

function bridgeUnavailableResponse(): AssistantBridgeResponse {
	return {
		status: 'error',
		code: 'assistant_failed',
		message: 'Desktop bridge is unavailable.',
		detail: 'Open this interface with bun run desktop:dev or the Tauri app.',
	}
}

function bridgeErrorResponse(err: unknown): AssistantBridgeResponse {
	return {
		status: 'error',
		code: 'assistant_failed',
		message: 'Assistant bridge failed.',
		detail: err instanceof Error ? err.message : String(err),
	}
}

function isTauriRuntime(): boolean {
	const candidate = globalThis as typeof globalThis & {
		__TAURI_INTERNALS__?: unknown
	}

	return typeof candidate.__TAURI_INTERNALS__ !== 'undefined'
}
