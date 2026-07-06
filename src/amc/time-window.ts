import type { AmcTimeWindow } from "./types.js";

const DEFAULT_TIME_ZONE = "UTC";

export class AmcTimeWindowError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "AmcTimeWindowError";
	}
}

export function resolveAmazonMarketingCloudTimeWindow(input: {
	readonly question: string;
	readonly since?: string;
	readonly until?: string;
	readonly timeZone?: string;
	readonly now?: Date;
}): AmcTimeWindow {
	const timeZone = input.timeZone ?? DEFAULT_TIME_ZONE;
	if (input.since || input.until) {
		if (!input.since || !input.until) {
			throw new AmcTimeWindowError(
				"AMC requires both --since and --until for explicit time windows.",
			);
		}
		return {
			type: "EXPLICIT",
			start: formatAmazonMarketingCloudDateTime(input.since),
			end: formatAmazonMarketingCloudDateTime(input.until),
			timeZone,
		};
	}

	const inferred = inferRelativeTimeWindow(
		input.question,
		input.now ?? new Date(),
	);
	if (inferred) {
		return {
			type: "EXPLICIT",
			start: formatAmazonMarketingCloudDateTime(inferred.start),
			end: formatAmazonMarketingCloudDateTime(inferred.end),
			timeZone,
		};
	}

	throw new AmcTimeWindowError(
		"AMC queries require a time window. Add --since and --until, or include a timeframe such as 'last 30 days' in the question.",
	);
}

export function formatAmazonMarketingCloudDateTime(
	value: string | Date,
): string {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) {
		throw new AmcTimeWindowError(`Invalid AMC datetime: ${String(value)}`);
	}
	return date.toISOString().replace(/\.\d{3}Z$/, "");
}

function inferRelativeTimeWindow(
	question: string,
	now: Date,
): { readonly start: Date; readonly end: Date } | undefined {
	const match =
		/\b(?:last|past|over|previous)\s+(\d{1,4})\s+(day|days|week|weeks|month|months)\b/i.exec(
			question,
		);
	if (!match) return undefined;

	const amount = Number(match[1]);
	const unit = match[2].toLowerCase();
	const end = new Date(now);
	const start = new Date(now);

	if (unit.startsWith("day")) {
		start.setUTCDate(start.getUTCDate() - amount);
	} else if (unit.startsWith("week")) {
		start.setUTCDate(start.getUTCDate() - amount * 7);
	} else {
		start.setUTCMonth(start.getUTCMonth() - amount);
	}

	return { start, end };
}
