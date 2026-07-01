import type {
	AssistantApprovalRequest,
	AssistantBridgeResponse,
	DesktopSettingsResponse,
} from './assistant-bridge'

export type AssistantMessageRole = 'user' | 'assistant' | 'system'
export type AssistantMessageTone = 'normal' | 'error' | 'approval'

export interface AssistantMessage {
	readonly id: string
	readonly role: AssistantMessageRole
	readonly text: string
	readonly meta: string
	readonly tone: AssistantMessageTone
	readonly approval?: AssistantApprovalRequest
}

export function createMessage(
	options: Omit<AssistantMessage, 'id'>,
	id: string = createMessageId(),
): AssistantMessage {
	return {
		id,
		...options,
	}
}

export function createMessageFromResponse(
	response: AssistantBridgeResponse,
	id?: string,
): AssistantMessage {
	if (response.status === 'success') {
		return createMessage(
			{
				role: 'assistant',
				text: response.text,
				meta: `${response.connectionName} · ${response.databaseName} · ${Math.round(response.latencyMs)}ms`,
				tone: 'normal',
			},
			id,
		)
	}

	if (response.status === 'needsApproval') {
		return createMessage(
			{
				role: 'system',
				text: response.message,
				meta: `${response.connectionName} · approval required`,
				tone: 'approval',
				approval: response,
			},
			id,
		)
	}

	return createMessage(
		{
			role: 'system',
			text: response.detail
				? `${response.message}\n\n${response.detail}`
				: response.message,
			meta: response.code.replace(/_/g, ' '),
			tone: 'error',
		},
		id,
	)
}

export function createApprovalDeniedMessage(
	approval: AssistantApprovalRequest,
	id?: string,
): AssistantMessage {
	return createMessage(
		{
			role: 'system',
			text: `Query cancelled. qcp did not execute the pending SQL:\n\n${approval.sql}`,
			meta: `${approval.connectionName} · approval denied`,
			tone: 'error',
		},
		id,
	)
}

export function formatApprovalType(type: string): string {
	return type.replace(/_/g, ' ')
}

export function formatSettingsStatus(settings: DesktopSettingsResponse): string {
	if (settings.status === 'ready') return 'Ready'
	if (settings.status === 'missing_connection') return 'Connection needed'
	if (settings.status === 'missing_schema') return 'Schema scan needed'
	return 'Needs attention'
}

function createMessageId(): string {
	return globalThis.crypto?.randomUUID?.() ?? `message-${Date.now().toString(36)}`
}
