import type { AutomationDefinitionRecord } from "./types.js";

interface CronRange {
	readonly min: number;
	readonly max: number;
}

const CRON_RANGES: readonly CronRange[] = [
	{ min: 0, max: 59 },
	{ min: 0, max: 23 },
	{ min: 1, max: 31 },
	{ min: 1, max: 12 },
	{ min: 0, max: 7 },
];

export function getNextRunAt(
	cronExpression: string,
	from: Date = new Date(),
): Date | null {
	const fields = cronExpression.trim().split(/\s+/);
	if (fields.length !== CRON_RANGES.length) return null;

	const start = new Date(from);
	start.setUTCSeconds(0, 0);
	start.setUTCMinutes(start.getUTCMinutes() + 1);

	const maxLookaheadMinutes = 366 * 24 * 60;
	for (let offset = 0; offset < maxLookaheadMinutes; offset += 1) {
		const candidate = new Date(start.getTime() + offset * 60_000);
		if (matchesCron(candidate, fields)) {
			return candidate;
		}
	}

	return null;
}

export function isAutomationDue(
	definition: AutomationDefinitionRecord,
	at: Date = new Date(),
): boolean {
	if (definition.status !== "active") return false;
	if (definition.spec.trigger.type !== "cron") return false;
	if (!definition.nextRunAt) return false;

	return Date.parse(definition.nextRunAt) <= at.getTime();
}

function matchesCron(date: Date, fields: readonly string[]): boolean {
	const values = [
		date.getUTCMinutes(),
		date.getUTCHours(),
		date.getUTCDate(),
		date.getUTCMonth() + 1,
		date.getUTCDay(),
	] as const;

	return fields.every((field, index) =>
		matchesCronField(field, values[index], CRON_RANGES[index]),
	);
}

function matchesCronField(
	field: string,
	value: number,
	range: CronRange,
): boolean {
	if (field === "*") return true;

	const stepMatch = field.match(/^\*\/(\d+)$/);
	if (stepMatch) {
		const step = Number(stepMatch[1]);
		return Number.isInteger(step) && step >= 1 && value % step === 0;
	}

	const expected = Number(field);
	if (!Number.isInteger(expected)) return false;
	if (expected < range.min || expected > range.max) return false;

	return (
		expected === value ||
		(indexIsDayOfWeek(range) && expected === 7 && value === 0)
	);
}

function indexIsDayOfWeek(range: CronRange): boolean {
	return range.min === 0 && range.max === 7;
}
