import {
	type AuditAction,
	type AuditContext,
	type AuditOutcome,
	type AuditResource,
	buildAuditResource,
	type JsonValue,
	resolveAuditActor,
	writeAuditEvent,
} from "@/logger/audit.js";

export interface SemanticAuditOptions {
	readonly context?: AuditContext;
	readonly action: Extract<
		AuditAction,
		"SEMANTIC_SCAN" | "SEMANTIC_ANNOTATION" | "SEMANTIC_PROFILE"
	>;
	readonly outcome: AuditOutcome;
	readonly resource?: AuditResource;
	readonly metadata?: JsonValue;
}

export async function writeSemanticAuditEvent(
	options: SemanticAuditOptions,
): Promise<void> {
	if (!options.context) return;

	await writeAuditEvent(
		{
			scope:
				options.action === "SEMANTIC_PROFILE" ? "data_access" : "schema_change",
			action: options.action,
			actor: resolveAuditActor(options.context.installId),
			resource: {
				...buildAuditResource(options.context),
				...options.resource,
			},
			delta: null,
			outcome: options.outcome,
			metadata: options.metadata,
		},
		{ logsDir: options.context.logsDir },
	);
}
