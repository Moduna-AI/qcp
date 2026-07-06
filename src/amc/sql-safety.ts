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
	const errors: string[] = [];

	if (!trimmed) {
		errors.push("SQL is empty.");
	}

	if (/--|\/\*|\*\//.test(trimmed)) {
		errors.push("SQL comments are not allowed for AMC execution.");
	}

	const withoutTrailingSemicolon = trimmed.replace(/;\s*$/, "");
	if (withoutTrailingSemicolon.includes(";")) {
		errors.push("Only one SQL statement is allowed.");
	}

	if (!/^(SELECT|WITH)\b/i.test(withoutTrailingSemicolon)) {
		errors.push("AMC queries must start with SELECT or WITH.");
	}

	const forbidden = forbiddenKeywordPattern.exec(withoutTrailingSemicolon);
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
