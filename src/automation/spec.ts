import type {
	AutomationAction,
	AutomationReview,
	AutomationSpecV1,
	AutomationTrigger,
} from "./types.js";

export interface AutomationSpecValidationResult {
	readonly valid: boolean;
	readonly issues: readonly string[];
}

const ENV_VAR_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const CRON_FIELD_COUNT = 5;

export function validateAutomationSpec(
	spec: AutomationSpecV1,
): AutomationSpecValidationResult {
	const issues: string[] = [];

	for (const envVar of spec.requiredEnvVars) {
		if (!ENV_VAR_PATTERN.test(envVar)) {
			issues.push(`Invalid environment variable reference: ${envVar}`);
		}
	}

	if (spec.trigger.type === "cron") {
		const cronIssues = validateCronExpression(spec.trigger.cron);
		issues.push(...cronIssues);
	}

	if (!spec.safety.readOnly) {
		issues.push("Automation safety must be read-only.");
	}

	if (!spec.safety.requiresApproval) {
		issues.push("Automation safety must require human approval.");
	}

	if (spec.action.type === "qcp.ask.readonly") {
		if (!ENV_VAR_PATTERN.test(spec.action.databaseSecretEnv)) {
			issues.push(
				`Invalid database secret reference: ${spec.action.databaseSecretEnv}`,
			);
		}

		if (!spec.requiredEnvVars.includes(spec.action.databaseSecretEnv)) {
			issues.push(
				`Database secret reference ${spec.action.databaseSecretEnv} must be listed in requiredEnvVars.`,
			);
		}

		if (
			spec.safety.maxRows !== undefined &&
			spec.action.maxRows > spec.safety.maxRows
		) {
			issues.push(
				`Action maxRows (${spec.action.maxRows}) exceeds safety maxRows (${spec.safety.maxRows}).`,
			);
		}
	}

	return {
		valid: issues.length === 0,
		issues,
	};
}

export function createAutomationReview(
	spec: AutomationSpecV1,
	validationIssues: readonly string[] = [],
): AutomationReview {
	return {
		summary: `${spec.name}: ${spec.description}`,
		trigger: describeAutomationTrigger(spec.trigger),
		action: describeAutomationAction(spec.action),
		requiredEnvVars: [...spec.requiredEnvVars],
		safety: describeAutomationSafety(spec),
		expectedRunOutput: describeExpectedRunOutput(spec.action),
		validationIssues: [...validationIssues],
	};
}

export function describeAutomationTrigger(trigger: AutomationTrigger): string {
	if (trigger.type === "manual") {
		return "Manual trigger only.";
	}

	return `Cron schedule ${trigger.cron}${
		trigger.timezone ? ` (${trigger.timezone})` : ""
	}.`;
}

export function describeAutomationAction(action: AutomationAction): string {
	if (action.type === "test.heartbeat") {
		return `Send heartbeat output: ${action.message}`;
	}

	return `Run read-only qcp ask on connection ${action.connectionName} with max ${action.maxRows} rows.`;
}

export function describeAutomationSafety(spec: AutomationSpecV1): string[] {
	const safety = [
		"Read-only execution is required.",
		"Human approval is required before activation.",
	];

	if (spec.safety.maxRows !== undefined) {
		safety.push(`Maximum database rows: ${spec.safety.maxRows}.`);
	}

	if (spec.action.type === "qcp.ask.readonly") {
		safety.push(
			`Database URL must be supplied by secret env ref ${spec.action.databaseSecretEnv}; raw secrets are not stored in the automation spec.`,
		);
	}

	return safety;
}

export function describeExpectedRunOutput(action: AutomationAction): string {
	if (action.type === "test.heartbeat") {
		return "A timestamped heartbeat result with the configured message.";
	}

	return "A sanitized read-only qcp answer and bounded result metadata.";
}

export function createHeartbeatAutomationSpec(): AutomationSpecV1 {
	return {
		version: "v1",
		name: "Heartbeat Test",
		description: "A test automation that emits a heartbeat result.",
		trigger: {
			type: "manual",
		},
		action: {
			type: "test.heartbeat",
			message: "qcp automation heartbeat",
		},
		requiredEnvVars: [],
		safety: {
			readOnly: true,
			requiresApproval: true,
		},
	};
}

function validateCronExpression(cronExpression: string): string[] {
	const fields = cronExpression.trim().split(/\s+/);
	if (fields.length !== CRON_FIELD_COUNT) {
		return ["Cron trigger must use a 5-field cron expression."];
	}

	const ranges = [
		{ label: "minute", min: 0, max: 59 },
		{ label: "hour", min: 0, max: 23 },
		{ label: "day of month", min: 1, max: 31 },
		{ label: "month", min: 1, max: 12 },
		{ label: "day of week", min: 0, max: 7 },
	] as const;

	const issues: string[] = [];
	fields.forEach((field, index) => {
		const range = ranges[index];
		if (!isSupportedCronField(field, range.min, range.max)) {
			issues.push(`Unsupported cron ${range.label} field: ${field}`);
		}
	});

	return issues;
}

function isSupportedCronField(
	field: string,
	min: number,
	max: number,
): boolean {
	if (field === "*") return true;

	const stepMatch = field.match(/^\*\/(\d+)$/);
	if (stepMatch) {
		const step = Number(stepMatch[1]);
		return Number.isInteger(step) && step >= 1 && step <= max;
	}

	const numberValue = Number(field);
	return (
		Number.isInteger(numberValue) && numberValue >= min && numberValue <= max
	);
}
