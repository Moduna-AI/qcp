import { describe, expect, test } from 'bun:test'
import {
	assistantBridgeResponseSchema,
	desktopSettingsResponseSchema,
} from './assistant-bridge'

describe('assistant bridge response schema', () => {
	test('validates assistant success payloads', () => {
		const response = assistantBridgeResponseSchema.parse({
			status: 'success',
			text: 'The database has 12 tables.',
			direct: false,
			latencyMs: 110,
			connectionName: 'local',
			databaseName: 'app',
			tableCount: 12,
			provider: 'gemini',
			model: 'gemini-2.5-flash',
		})

		expect(response.status).toBe('success')
	})

	test('validates approval payloads', () => {
		const response = assistantBridgeResponseSchema.parse({
			status: 'needsApproval',
			requestId: 'approval-1',
			originalPrompt: 'Show all events',
			reasons: [{ type: 'large_scan', detail: 'Estimated scan is large' }],
			sql: 'select * from events',
			message: 'This query needs approval before qcp can execute it.',
			connectionName: 'local',
		})

		expect(response.status).toBe('needsApproval')
	})

	test('validates settings payloads', () => {
		const response = desktopSettingsResponseSchema.parse({
			status: 'ready',
			appVersion: '0.1.4-beta',
			runtimeMode: 'sidecar',
			activeConnection: {
				id: 'default',
				name: 'local',
				databaseType: 'other-postgres',
			},
			schema: {
				status: 'ready',
				databaseName: 'app',
				tableCount: 12,
				scannedAt: '2026-07-01T00:00:00.000Z',
			},
			provider: {
				name: 'gemini',
				model: 'gemini-2.5-flash',
			},
			safeMode: true,
			telemetry: false,
		})

		expect(response.status).toBe('ready')
	})

	test('rejects unknown status values', () => {
		expect(() =>
			assistantBridgeResponseSchema.parse({ status: 'pending' }),
		).toThrow()
	})
})
