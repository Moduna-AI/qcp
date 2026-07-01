import { describe, expect, test } from 'bun:test'
import {
	desktopApprovalRequestSchema,
	desktopAssistantRequestSchema,
	desktopAssistantResponseSchema,
	desktopSettingsResponseSchema,
	resolveDesktopApproval,
} from './assistant-runtime'

describe('desktop assistant runtime schemas', () => {
	test('validates prompt requests', () => {
		const request = desktopAssistantRequestSchema.parse({
			prompt: 'List tables',
			sessionId: 'session-1',
		})

		expect(request).toEqual({
			prompt: 'List tables',
			sessionId: 'session-1',
		})
	})

	test('validates approval requests', () => {
		const request = desktopApprovalRequestSchema.parse({
			originalPrompt: 'Show all users',
			approvedSql: 'select * from users',
			approvedRequestId: 'approval-1',
			sessionId: 'session-1',
		})

		expect(request.approvedSql).toBe('select * from users')
	})

	test('rejects empty prompt requests', () => {
		expect(() => desktopAssistantRequestSchema.parse({ prompt: '' })).toThrow()
	})

	test('validates success responses', () => {
		const response = desktopAssistantResponseSchema.parse({
			status: 'success',
			text: 'I know about 4 tables.',
			direct: true,
			latencyMs: 12,
			connectionName: 'local',
			databaseName: 'app',
			tableCount: 4,
			provider: 'gemini',
			model: 'gemini-2.5-flash',
		})

		expect(response.status).toBe('success')
	})

	test('validates approval responses', () => {
		const response = desktopAssistantResponseSchema.parse({
			status: 'needsApproval',
			requestId: 'approval-1',
			originalPrompt: 'Show all users',
			reasons: [{ type: 'no_limit', detail: 'Query has no LIMIT' }],
			sql: 'select * from users',
			message: 'This query needs approval before qcp can execute it.',
			connectionName: 'local',
		})

		expect(response.status).toBe('needsApproval')
	})

	test('approves exact regenerated SQL', () => {
		const decision = resolveDesktopApproval({
			reasons: [{ type: 'no_limit', detail: 'Query has no LIMIT' }],
			sql: 'select *\nfrom users',
			prompt: 'Show all users',
			approvedSql: 'select * from users',
		})

		expect(decision.approved).toBe(true)
		expect(decision.pendingApproval).toBeUndefined()
	})

	test('re-prompts when regenerated SQL differs from approved SQL', () => {
		const decision = resolveDesktopApproval({
			reasons: [{ type: 'no_limit', detail: 'Query has no LIMIT' }],
			sql: 'select id from users',
			prompt: 'Show all users',
			approvedSql: 'select * from users',
		})

		expect(decision.approved).toBe(false)
		expect(decision.pendingApproval?.sql).toBe('select id from users')
	})

	test('validates settings responses for missing connection', () => {
		const response = desktopSettingsResponseSchema.parse({
			status: 'missing_connection',
			appVersion: '0.1.4-beta',
			runtimeMode: 'sidecar',
			schema: {
				status: 'missing',
				message: 'No database connection is configured.',
				command: 'qcp connect',
			},
			provider: {
				name: 'gemini',
				model: 'gemini-2.5-flash',
			},
			safeMode: true,
			telemetry: false,
		})

		expect(response.schema.status).toBe('missing')
	})
})
