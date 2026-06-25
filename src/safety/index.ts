/**
 * SQL Safety Module
 *
 * Uses pgsql-ast-parser v12 for AST-based validation.
 * Fail-safe: any parse error → reject.
 * EXPLAIN is handled with a pre-parse check + inner SELECT validation.
 */

import type { Statement } from "pgsql-ast-parser";
import { parse } from "pgsql-ast-parser";
import type { ApprovalReason, SafetyReport } from "@/types/index.js";

// ─── Statement allowlist ──────────────────────────────────────────────────────

const ALLOWED_STATEMENT_TYPES = new Set(["select", "with"]);

// ─── Known dangerous types for better error messages ──────────────────────────

const DANGEROUS_STATEMENT_TYPES: Record<string, string> = {
	insert: "INSERT",
	update: "UPDATE",
	delete: "DELETE",
	"drop table": "DROP TABLE",
	"drop index": "DROP INDEX",
	"drop sequence": "DROP SEQUENCE",
	"drop view": "DROP VIEW",
	"drop type": "DROP TYPE",
	"drop schema": "DROP SCHEMA",
	"create table": "CREATE TABLE",
	"create index": "CREATE INDEX",
	"create sequence": "CREATE SEQUENCE",
	"create view": "CREATE VIEW",
	"create schema": "CREATE SCHEMA",
	"alter table": "ALTER TABLE",
	"alter sequence": "ALTER SEQUENCE",
	"truncate table": "TRUNCATE",
	grant: "GRANT",
	revoke: "REVOKE",
	copy: "COPY",
	do: "DO (procedural block)",
};

const MAX_LIMIT = 100;

// ─── EXPLAIN detection ────────────────────────────────────────────────────────
// pgsql-ast-parser v12 does not parse EXPLAIN.
// We detect it manually (safe — EXPLAIN never writes data)
// and validate the inner SELECT via AST.

const EXPLAIN_REGEX = /^\s*EXPLAIN\s*(\([^)]*\))?\s*/i;

function isExplainStatement(sql: string): boolean {
	return EXPLAIN_REGEX.test(sql);
}

function stripExplainPrefix(sql: string): string {
	return sql.replace(EXPLAIN_REGEX, "").trim();
}

// ─── Main validation ──────────────────────────────────────────────────────────

export function validateSql(sql: string): SafetyReport {
	const report: SafetyReport = {
		safe: false,
		readOnly: false,
		allowedStatement: false,
		limitApplied: false,
		errors: [],
		warnings: [],
		processedSql: sql.trim(),
		statementType: "unknown",
	};

	const trimmedSql = sql.trim();
	if (!trimmedSql) {
		report.errors.push("Empty SQL query.");
		return report;
	}
	const firstKeyword = trimmedSql.match(/^\s*([a-zA-Z]+)/)?.[1]?.toUpperCase();

	const blockedKeywords = new Set([
		"INSERT",
		"UPDATE",
		"DELETE",
		"DROP",
		"ALTER",
		"CREATE",
		"TRUNCATE",
		"REPLACE",
		"MERGE",
		"CALL",
		"EXEC",
		"EXECUTE",
		"GRANT",
		"REVOKE",
	]);

	if (firstKeyword && blockedKeywords.has(firstKeyword)) {
		report.statementType = firstKeyword.toLowerCase();
		report.errors.push(
			`Dangerous operation rejected: ${firstKeyword} is not permitted. ` +
				`qcp is read-only — only SELECT, WITH, and EXPLAIN are allowed.`,
		);
		return report;
	}

	// ── Handle EXPLAIN ─────────────────────────────────────────────────────────
	if (isExplainStatement(trimmedSql)) {
		const innerSql = stripExplainPrefix(trimmedSql);
		if (!innerSql) {
			report.errors.push("EXPLAIN requires a query.");
			return report;
		}

		// Validate the inner SELECT
		const innerReport = validateSql(innerSql);
		if (!innerReport.safe) {
			report.errors.push(
				`EXPLAIN inner query rejected: ${innerReport.errors[0]}`,
			);
			return report;
		}

		report.safe = true;
		report.readOnly = true;
		report.allowedStatement = true;
		report.statementType = "explain";
		// EXPLAIN doesn't return rows — no LIMIT injection needed
		report.processedSql = trimmedSql.replace(/;\s*$/, "");
		return report;
	}

	// ── AST parse ──────────────────────────────────────────────────────────────
	let statements: Statement[];
	try {
		statements = parse(trimmedSql, { locationTracking: false });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
		report.errors.push(
			`SQL parsing failed: ${msg}. Query rejected for safety.`,
		);
		return report;
	}

	if (!statements?.length) {
		report.errors.push("No valid SQL statements found.");
		return report;
	}

	if (statements.length > 1) {
		report.errors.push(
			`Multiple SQL statements are not permitted (found ${statements.length}). ` +
				`Only a single SELECT or WITH is allowed.`,
		);
		return report;
	}

	const stmt = statements[0];
	const stmtType = stmt.type.toLowerCase();
	report.statementType = stmtType;

	// ── Allowlist check ────────────────────────────────────────────────────────
	if (!ALLOWED_STATEMENT_TYPES.has(stmtType)) {
		const label = DANGEROUS_STATEMENT_TYPES[stmtType];
		if (label) {
			report.errors.push(
				`Dangerous operation rejected: ${label} is not permitted. ` +
					`qcp is read-only — only SELECT and WITH are allowed.`,
			);
		} else {
			report.errors.push(
				`Statement type '${stmtType.toUpperCase()}' is not permitted. ` +
					`Only SELECT, WITH, and EXPLAIN are allowed.`,
			);
		}
		return report;
	}

	report.allowedStatement = true;
	report.readOnly = true;

	// ── LIMIT injection ────────────────────────────────────────────────────────
	let processedSql = trimmedSql.replace(/;\s*$/, "");

	const hasLimit = statementHasLimit(stmt);
	if (!hasLimit) {
		processedSql = `${processedSql}\nLIMIT ${MAX_LIMIT}`;
		report.limitApplied = true;
		report.warnings.push(`LIMIT ${MAX_LIMIT} automatically applied.`);
	} else {
		const userLimit = extractLimitValue(stmt);
		if (userLimit !== null && userLimit > MAX_LIMIT) {
			processedSql = processedSql.replace(
				/\bLIMIT\s+\d+/i,
				`LIMIT ${MAX_LIMIT}`,
			);
			report.warnings.push(`LIMIT reduced to ${MAX_LIMIT} (was ${userLimit}).`);
		}
	}

	report.processedSql = processedSql;
	report.safe = true;
	return report;
}

// ─── LIMIT helpers ────────────────────────────────────────────────────────────

function statementHasLimit(stmt: Statement): boolean {
	if (stmt.type === "select") {
		return !!(stmt as unknown as { limit?: { limit?: unknown } }).limit?.limit;
	}
	if (stmt.type === "with") {
		const inner = (stmt as unknown as { in?: Statement }).in;
		return inner ? statementHasLimit(inner) : false;
	}
	return false;
}

function extractLimitValue(stmt: Statement): number | null {
	try {
		const s = stmt as unknown as { limit?: { limit?: { value?: unknown } } };
		const v = s.limit?.limit?.value;
		return typeof v === "number" ? v : null;
	} catch {
		return null;
	}
}

// ─── Sensitive table detection ────────────────────────────────────────────────

export function detectSensitiveTables(
	sql: string,
	patterns: string[],
): string[] {
	const lower = sql.toLowerCase();
	const found = patterns.filter((p) => lower.includes(p.toLowerCase()));
	return [...new Set(found)];
}

// ─── Approval reasons ─────────────────────────────────────────────────────────

export function getApprovalReasons(
	sql: string,
	_report: SafetyReport,
	sensitivePatterns: string[],
	estimatedRows?: number,
): ApprovalReason[] {
	const reasons: ApprovalReason[] = [];

	const sensitiveFound = detectSensitiveTables(sql, sensitivePatterns);
	if (sensitiveFound.length > 0) {
		reasons.push({
			type: "sensitive_table",
			detail: `Accessing potentially sensitive tables: ${sensitiveFound.join(", ")}`,
		});
	}

	if (estimatedRows !== undefined && estimatedRows > 10_000) {
		reasons.push({
			type: "high_cost",
			detail: `Estimated ${estimatedRows.toLocaleString()} rows scanned`,
		});
	}

	return reasons;
}

export function safetyReportToJson(report: SafetyReport) {
	return {
		readOnly: report.readOnly,
		allowedStatement: report.allowedStatement,
		limitApplied: report.limitApplied,
	};
}
