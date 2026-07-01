import { z } from 'zod'

export const promptCaptureSchema = z.object({
	id: z.string().min(1),
	text: z.string().min(1),
	createdAt: z.string().datetime(),
})

export const promptCaptureListSchema = z.array(promptCaptureSchema)

export type PromptCapture = z.infer<typeof promptCaptureSchema>

export interface PromptStorage {
	getItem(key: string): string | null
	setItem(key: string, value: string): void
	removeItem(key: string): void
}

export const PROMPT_CAPTURE_STORAGE_KEY = 'qcp.desktop.promptCaptures.v1'

export function createPromptCapture(
	text: string,
	options: { id?: string; now?: Date } = {},
): PromptCapture | null {
	const trimmedText = text.trim()

	if (trimmedText.length === 0) {
		return null
	}

	return {
		id: options.id ?? createCaptureId(),
		text: trimmedText,
		createdAt: (options.now ?? new Date()).toISOString(),
	}
}

export function readPromptCaptures(
	storage: PromptStorage,
	key: string = PROMPT_CAPTURE_STORAGE_KEY,
): PromptCapture[] {
	const rawCaptures = storage.getItem(key)

	if (rawCaptures === null) {
		return []
	}

	try {
		const parsedCaptures: unknown = JSON.parse(rawCaptures)
		const result = promptCaptureListSchema.safeParse(parsedCaptures)
		return result.success ? result.data : []
	} catch {
		return []
	}
}

export function writePromptCaptures(
	storage: PromptStorage,
	captures: PromptCapture[],
	key: string = PROMPT_CAPTURE_STORAGE_KEY,
): void {
	storage.setItem(key, JSON.stringify(captures))
}

export function prependPromptCapture(
	captures: PromptCapture[],
	capture: PromptCapture,
	limit: number = 8,
): PromptCapture[] {
	return [capture, ...captures].slice(0, limit)
}

function createCaptureId(): string {
	return globalThis.crypto?.randomUUID?.() ?? `capture-${Date.now().toString(36)}`
}
