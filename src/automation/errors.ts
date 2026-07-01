export class AutomationError extends Error {
	public constructor(message: string, options?: { cause?: unknown }) {
		super(message);
		this.name = "AutomationError";
		this.cause = options?.cause;
	}
}

export class AutomationConfigError extends AutomationError {
	public constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "AutomationConfigError";
	}
}

export class AutomationControlApiError extends AutomationError {
	public readonly status?: number;

	public constructor(
		message: string,
		options?: { status?: number; cause?: unknown },
	) {
		super(message, options);
		this.name = "AutomationControlApiError";
		this.status = options?.status;
	}
}

export class AutomationGenerationError extends AutomationError {
	public constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "AutomationGenerationError";
	}
}

export class AutomationRegistryError extends AutomationError {
	public constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "AutomationRegistryError";
	}
}

export function getAutomationErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
