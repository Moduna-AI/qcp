import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import { QcpSupervisorAgent } from '@/agents/index.js'
import {
	getActiveDatabaseConnection,
	loadConfig,
	withActiveDatabaseConnection,
} from '@/config/index.js'
import { classifyPromptViolation, sanitizeSensitiveData } from '@/safety/index.js'
import { loadSchemaForConnection } from '@/schema/index.js'
import {
	initTelemetry,
	shutdownTelemetry,
	trackActive,
	trackError,
	trackHumanApproval,
	trackQuery,
	trackQueryRejected,
} from '@/telemetry/index.js'
import type { ApprovalReason, QcpConfig } from '@/types/index.js'
import { QCP_VERSION } from '@/version.js'

const approvalReasonSchema = z.object({
	type: z.enum(['sensitive_table', 'large_scan', 'no_limit', 'high_cost']),
	detail: z.string(),
})

export const desktopAssistantRequestSchema = z.object({
	prompt: z.string().min(1),
	sessionId: z.string().min(1).optional(),
})

export const desktopApprovalRequestSchema = z.object({
	originalPrompt: z.string().min(1),
	approvedSql: z.string().min(1),
	approvedRequestId: z.string().min(1),
	sessionId: z.string().min(1).optional(),
})

const desktopAssistantSuccessSchema = z.object({
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

const desktopAssistantNeedsApprovalSchema = z.object({
	status: z.literal('needsApproval'),
	requestId: z.string(),
	originalPrompt: z.string(),
	reasons: z.array(approvalReasonSchema),
	sql: z.string(),
	message: z.string(),
	connectionName: z.string(),
})

const desktopAssistantErrorSchema = z.object({
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

export const desktopAssistantResponseSchema = z.discriminatedUnion('status', [
	desktopAssistantSuccessSchema,
	desktopAssistantNeedsApprovalSchema,
	desktopAssistantErrorSchema,
])

const activeConnectionSchema = z.object({
	id: z.string(),
	name: z.string(),
	databaseType: z.string(),
})

const desktopSettingsSchemaStatusSchema = z.discriminatedUnion('status', [
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
	activeConnection: activeConnectionSchema.optional(),
	schema: desktopSettingsSchemaStatusSchema,
	provider: z.object({
		name: z.string(),
		model: z.string(),
	}),
	safeMode: z.boolean(),
	telemetry: z.boolean(),
})

export const desktopRunnerRequestSchema = z.discriminatedUnion('command', [
	z.object({
		command: z.literal('submitPrompt'),
		request: desktopAssistantRequestSchema,
	}),
	z.object({
		command: z.literal('approvePrompt'),
		request: desktopApprovalRequestSchema,
	}),
	z.object({
		command: z.literal('getSettings'),
	}),
])

export type DesktopAssistantRequest = z.infer<
	typeof desktopAssistantRequestSchema
>

export type DesktopApprovalRequest = z.infer<
	typeof desktopApprovalRequestSchema
>

export type DesktopAssistantResponse = z.infer<
	typeof desktopAssistantResponseSchema
>

export type DesktopSettingsResponse = z.infer<
	typeof desktopSettingsResponseSchema
>

export type DesktopRunnerRequest = z.infer<typeof desktopRunnerRequestSchema>

interface PendingApproval {
	readonly requestId: string
	readonly originalPrompt: string
	readonly reasons: ApprovalReason[]
	readonly sql: string
}

interface PromptRunOptions {
	readonly prompt: string
	readonly sessionId?: string
	readonly approvedSql?: string
	readonly approvedRequestId?: string
}

interface DesktopApprovalResolution {
	readonly approved: boolean
	readonly pendingApproval?: PendingApproval
}

export async function runDesktopAssistantPrompt(
	request: DesktopAssistantRequest,
): Promise<DesktopAssistantResponse> {
	const parsedRequest = desktopAssistantRequestSchema.parse(request)
	return runPrompt({
		prompt: parsedRequest.prompt,
		sessionId: parsedRequest.sessionId,
	})
}

export async function approveDesktopAssistantPrompt(
	request: DesktopApprovalRequest,
): Promise<DesktopAssistantResponse> {
	const parsedRequest = desktopApprovalRequestSchema.parse(request)
	return runPrompt({
		prompt: parsedRequest.originalPrompt,
		sessionId: parsedRequest.sessionId,
		approvedSql: parsedRequest.approvedSql,
		approvedRequestId: parsedRequest.approvedRequestId,
	})
}

export function resolveDesktopApproval(
	options: {
		readonly reasons: ApprovalReason[]
		readonly sql: string
		readonly prompt: string
		readonly approvedSql?: string
	},
): DesktopApprovalResolution {
	if (options.approvedSql && sameSql(options.sql, options.approvedSql)) {
		return { approved: true }
	}

	return {
		approved: false,
		pendingApproval: {
			requestId: uuidv7(),
			originalPrompt: options.prompt,
			reasons: options.reasons,
			sql: options.sql,
		},
	}
}

export function readDesktopSettings(
	runtimeMode: DesktopSettingsResponse['runtimeMode'] = readRuntimeMode(),
): DesktopSettingsResponse {
	const config = loadConfig()
	const connection = getActiveDatabaseConnection(config)

	if (!connection) {
		return {
			status: 'missing_connection',
			appVersion: QCP_VERSION,
			runtimeMode,
			schema: {
				status: 'missing',
				message: 'No database connection is configured.',
				command: 'qcp connect',
			},
			provider: {
				name: config.provider,
				model: config.model,
			},
			safeMode: config.safeMode,
			telemetry: config.telemetry,
		}
	}

	const activeConfig = withActiveDatabaseConnection(config, connection)
	const activeConnection = {
		id: connection.id,
		name: connection.name,
		databaseType: connection.databaseType,
	}

	try {
		const schemaResult = loadSchemaForConnection(connection)
		return {
			status: 'ready',
			appVersion: QCP_VERSION,
			runtimeMode,
			activeConnection,
			schema: {
				status: 'ready',
				databaseName: schemaResult.schema.databaseName,
				tableCount: schemaResult.schema.tableCount,
				scannedAt: schemaResult.schema.scannedAt,
			},
			provider: {
				name: activeConfig.provider,
				model: activeConfig.model,
			},
			safeMode: activeConfig.safeMode,
			telemetry: activeConfig.telemetry,
		}
	} catch (err: unknown) {
		return {
			status: 'missing_schema',
			appVersion: QCP_VERSION,
			runtimeMode,
			activeConnection,
			schema: {
				status: 'error',
				message: sanitizeSensitiveData(errorMessage(err)),
				command: 'qcp schema scan',
			},
			provider: {
				name: activeConfig.provider,
				model: activeConfig.model,
			},
			safeMode: activeConfig.safeMode,
			telemetry: activeConfig.telemetry,
		}
	}
}

export async function runDesktopCommand(
	request: DesktopRunnerRequest,
): Promise<DesktopAssistantResponse | DesktopSettingsResponse> {
	switch (request.command) {
		case 'submitPrompt':
			return runDesktopAssistantPrompt(request.request)
		case 'approvePrompt':
			return approveDesktopAssistantPrompt(request.request)
		case 'getSettings':
			return desktopSettingsResponseSchema.parse(readDesktopSettings())
	}
}

function readRuntimeMode(): DesktopSettingsResponse['runtimeMode'] {
	if (process.env.QCP_DESKTOP_RUNTIME_MODE === 'sidecar') return 'sidecar'
	if (process.env.QCP_DESKTOP_RUNTIME_MODE === 'bun') return 'bun'
	return 'unknown'
}

async function runPrompt(
	options: PromptRunOptions,
): Promise<DesktopAssistantResponse> {
	const prompt = options.prompt.trim()

	const config = loadConfig()
	initTelemetry(config)
	trackActive()

	try {
		const connection = getActiveDatabaseConnection(config)
		if (!connection) {
			return {
				status: 'error',
				code: 'missing_connection',
				message: 'No database connection configured.',
				detail: 'Run qcp connect before using the desktop assistant.',
			}
		}

		const activeConfig = withActiveDatabaseConnection(config, connection)
		const promptViolation = classifyPromptViolation(prompt)
		if (promptViolation) {
			trackQueryRejected(`${promptViolation.category}_prompt_violation`)
			return {
				status: 'error',
				code: 'prompt_violation',
				message: promptViolation.message,
				detail: `${promptViolation.title}: ${promptViolation.detail}`,
			}
		}

		let schemaResult: ReturnType<typeof loadSchemaForConnection>
		try {
			schemaResult = loadSchemaForConnection(connection)
		} catch (err: unknown) {
			return {
				status: 'error',
				code: 'missing_schema',
				message: 'Schema not found.',
				detail: `${errorMessage(err)} Run qcp schema scan before using the desktop assistant.`,
			}
		}

		const approvalState: { current: PendingApproval | null } = {
			current: null,
		}
		const supervisor = new QcpSupervisorAgent({
			config: activeConfig,
			command: 'desktop',
			sessionId: options.sessionId,
			connectionId: connection.id,
			connectionName: connection.name,
			databaseUrl: connection.databaseUrl,
			schema: schemaResult.schema,
			approvalHandler: async (reasons, sql) => {
				const decision = resolveDesktopApproval({
					reasons,
					sql,
					prompt,
					approvedSql: options.approvedSql,
				})

				if (decision.approved) {
					trackHumanApproval(true)
					return true
				}

				approvalState.current = decision.pendingApproval ?? null
				trackHumanApproval(false)
				return false
			},
		})

		const response = await supervisor.generateResponse(prompt)

		if (approvalState.current) {
			return {
				status: 'needsApproval',
				requestId: approvalState.current.requestId,
				originalPrompt: approvalState.current.originalPrompt,
				reasons: approvalState.current.reasons,
				sql: approvalState.current.sql,
				message: approvalMessage(options.approvedSql),
				connectionName: connection.name,
			}
		}

		trackQuery({
			provider: config.provider,
			model: config.model,
			latencyMs: response.latencyMs,
			approved: Boolean(options.approvedSql),
		})

		return {
			status: 'success',
			text: sanitizeSensitiveData(response.text.trim()),
			direct: response.direct,
			latencyMs: response.latencyMs,
			tokensIn: response.tokensIn,
			tokensOut: response.tokensOut,
			connectionName: connection.name,
			databaseName: schemaResult.schema.databaseName,
			tableCount: schemaResult.schema.tableCount,
			provider: activeConfig.provider,
			model: activeConfig.model,
		}
	} catch (err: unknown) {
		trackError('desktop', 'assistant_response_failed')
		return {
			status: 'error',
			code: 'assistant_failed',
			message: 'Assistant response failed.',
			detail: sanitizeSensitiveData(errorMessage(err)),
		}
	} finally {
		await shutdownTelemetry()
	}
}

function sameSql(left: string, right: string): boolean {
	return normalizeSql(left) === normalizeSql(right)
}

function normalizeSql(sql: string): string {
	return sql.trim().replace(/\s+/g, ' ')
}

function approvalMessage(approvedSql?: string): string {
	return approvedSql
		? 'The regenerated query differs from the approved SQL. Review the new query before execution.'
		: 'This query needs approval before qcp can execute it.'
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

export function getConfigRuntimeShapeForDesktop(
	config: QcpConfig,
): Pick<QcpConfig, 'provider' | 'model' | 'safeMode' | 'telemetry'> {
	return {
		provider: config.provider,
		model: config.model,
		safeMode: config.safeMode,
		telemetry: config.telemetry,
	}
}
