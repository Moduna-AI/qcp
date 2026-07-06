export interface AmcSqlValidationResult {
	readonly ok: boolean;
	readonly sql: string;
	readonly errors: readonly string[];
}

const forbiddenKeywordPattern =
	/\b(ALTER|CALL|COPY|CREATE|DELETE|DROP|GRANT|INSERT|MERGE|REPLACE|REVOKE|TRUNCATE|UPDATE|UNLOAD|VACUUM)\b/i;

export class AmcSqlValidationError extends Error {
	public constructor(readonly result: AmcSqlValidationResult) {
		super(result.errors.join(" "));
		this.name = "AmcSqlValidationError";
	}
}

export function validateAmazonMarketingCloudSql(
	sql: string,
): AmcSqlValidationResult {
	const trimmed = sql.trim();
	const sanitized = maskQuotedSql(trimmed);
	const errors: string[] = [];

	if (!trimmed) {
		errors.push("SQL is empty.");
	}

	if (/--|\/\*|\*\//.test(sanitized)) {
		errors.push("SQL comments are not allowed for AMC execution.");
	}

	const semicolonIndexes = findOutsideSemicolonIndexes(sanitized);
	const hasTrailingStatementTerminator =
		semicolonIndexes.length === 1 && sanitized.trimEnd().endsWith(";");
	if (
		semicolonIndexes.length > 1 ||
		(semicolonIndexes.length === 1 && !hasTrailingStatementTerminator)
	) {
		errors.push("Only one SQL statement is allowed.");
	}

	const withoutTrailingSemicolon = hasTrailingStatementTerminator
		? trimmed.replace(/;\s*$/, "")
		: trimmed;
	const sanitizedWithoutTrailingSemicolon = hasTrailingStatementTerminator
		? sanitized.replace(/;\s*$/, "")
		: sanitized;

	if (!/^(SELECT|WITH)\b/i.test(sanitizedWithoutTrailingSemicolon.trim())) {
		errors.push("AMC queries must start with SELECT or WITH.");
	}

	const forbidden = forbiddenKeywordPattern.exec(
		sanitizedWithoutTrailingSemicolon,
	);
	if (forbidden) {
		errors.push(`Forbidden AMC SQL keyword: ${forbidden[1].toUpperCase()}.`);
	}

	return {
		ok: errors.length === 0,
		sql: withoutTrailingSemicolon,
		errors,
	};
}

export function assertValidAmazonMarketingCloudSql(sql: string): string {
	const result = validateAmazonMarketingCloudSql(sql);
	if (!result.ok) {
		throw new AmcSqlValidationError(result);
	}
	return result.sql;
}

function maskQuotedSql(sql: string): string {
	let masked = "";
	let quote: "'" | '"' | "`" | undefined;

	for (let index = 0; index < sql.length; index += 1) {
		const char = sql[index];
		const next = sql[index + 1];

		if (quote) {
			masked += " ";
			if (char === quote) {
				if (next === quote) {
					masked += " ";
					index += 1;
				} else {
					quote = undefined;
				}
			}
			continue;
		}

		if (char === "'" || char === '"' || char === "`") {
			quote = char;
			masked += " ";
			continue;
		}

		masked += char;
	}

	return masked;
}

function findOutsideSemicolonIndexes(maskedSql: string): number[] {
	const indexes: number[] = [];
	for (let index = 0; index < maskedSql.length; index += 1) {
		if (maskedSql[index] === ";") indexes.push(index);
	}
	return indexes;
}
