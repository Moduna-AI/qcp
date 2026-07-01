import { describe, expect, test } from 'bun:test'
import {
	createApprovalDeniedMessage,
	createMessageFromResponse,
	formatSettingsStatus,
} from './desktop-ui-state'

describe('desktop UI state helpers', () => {
	test('creates approval messages with executable approval payloads', () => {
		const message = createMessageFromResponse(
			{
				status: 'needsApproval',
				requestId: 'approval-1',
				originalPrompt: 'Show all users',
				reasons: [{ type: 'sensitive_table', detail: 'users matched' }],
				sql: 'select * from users',
				message: 'This query needs approval before qcp can execute it.',
				connectionName: 'local',
			},
			'message-1',
		)

		expect(message.tone).toBe('approval')
		expect(message.approval?.sql).toBe('select * from users')
	})

	test('creates denial messages without an execution request', () => {
		const message = createApprovalDeniedMessage(
			{
				status: 'needsApproval',
				requestId: 'approval-1',
				originalPrompt: 'Show all users',
				reasons: [{ type: 'sensitive_table', detail: 'users matched' }],
				sql: 'select * from users',
				message: 'This query needs approval before qcp can execute it.',
				connectionName: 'local',
			},
			'message-2',
		)

		expect(message.meta).toContain('approval denied')
		expect(message.text).toContain('did not execute')
	})

	test('formats settings status labels', () => {
		expect(
			formatSettingsStatus({
				status: 'missing_connection',
				appVersion: '0.1.4-beta',
				runtimeMode: 'sidecar',
				schema: {
					status: 'missing',
					message: 'No connection',
					command: 'qcp connect',
				},
				provider: {
					name: 'gemini',
					model: 'gemini-2.5-flash',
				},
				safeMode: true,
				telemetry: false,
			}),
		).toBe('Connection needed')
	})
})
