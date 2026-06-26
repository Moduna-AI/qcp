/**
 * SQL Safety Module
 *
 * Uses pgsql-ast-parser v12 for AST-based validation.
 * Fail-safe: any parse error → reject.
 * EXPLAIN is handled with a pre-parse check + inner SELECT validation.
 *
 * Defence-in-depth layers (applied in order):
 *   1. Query length guard                — DoS protection
 *   2. Dangerous function scan           — catches pg_read_file(), lo_export(), dblink(), etc.
 *   3. First-keyword fast path           — rejects obvious non-read statements early
 *   4. EXPLAIN detection + recursion     — validates the inner query via validateSql()
 *   5. AST parse + statement allowlist   — catches anything the keyword check missed
 *   6. LIMIT injection / clamping        — bounds result-set size
 */

import type { Statement } from "pgsql-ast-parser";
import { parse } from "pgsql-ast-parser";
import type { ApprovalReason, SafetyReport } from "@/types/index.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const ALLOWED_STATEMENT_TYPES = new Set(["select", "with"]);
const MAX_LIMIT = 100;
/** ~16 KB is generous for any hand-written query while still bounding DoS risk. */
const MAX_QUERY_LENGTH = 16_000;

// ─── Known dangerous statement types (for human-readable error messages) ──────

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

// ─── Blocked first-keyword fast path ──────────────────────────────────────────
// Rejects obvious non-read statements before any expensive parsing.
// EXPLAIN is intentionally absent — it is handled separately below.

const BLOCKED_FIRST_KEYWORDS = new Set([
	// DML
	"INSERT",
	"UPDATE",
	"DELETE",
	"MERGE",
	"REPLACE",
	// DDL
	"CREATE",
	"DROP",
	"ALTER",
	"TRUNCATE",
	// Stored procedures / scripting
	"CALL",
	"EXEC",
	"EXECUTE",
	"DO",
	// Permissions
	"GRANT",
	"REVOKE",
	// File I/O
	"COPY",
	"IMPORT",
	"LOAD",
	// Session / transaction manipulation
	"SET",
	"RESET",
	"DISCARD",
	// Cursor management
	"DECLARE",
	"FETCH",
	"MOVE",
	"CLOSE",
	// Prepared statements
	"PREPARE",
	"DEALLOCATE",
	// Pub/sub
	"LISTEN",
	"NOTIFY",
	"UNLISTEN",
	// Admin / maintenance
	"VACUUM",
	"ANALYZE", // standalone ANALYZE table — not EXPLAIN ANALYZE (first keyword is EXPLAIN there)
	"CLUSTER",
	"REINDEX",
	"CHECKPOINT",
	// Locking
	"LOCK",
]);

// ─── Dangerous functions ───────────────────────────────────────────────────────
// Even inside a SELECT, these functions can escape the read-only sandbox:
// write to disk, execute remote queries, or tamper with session state.

const DANGEROUS_FUNCTIONS = new Set([
	// Filesystem reads (superuser-gated, but defence-in-depth)
	"pg_read_file",
	"pg_read_binary_file",
	"pg_ls_dir",
	"pg_stat_file",
	// Large-object file I/O (can read AND write arbitrary paths)
	"lo_export",
	"lo_import",
	"lo_create",
	"lo_unlink",
	// Remote execution via dblink extension
	"dblink",
	"dblink_exec",
	"dblink_connect",
	"dblink_connect_u",
	// Session/privilege manipulation
	"set_config",
	// Process management (can disrupt other backends)
	"pg_cancel_backend",
	"pg_terminate_backend",
]);

// ─── EXPLAIN detection ─────────────────────────────────────────────────────────
// pgsql-ast-parser v12 does not parse EXPLAIN, so we detect and handle it manually.
//
// Supported forms:
//   EXPLAIN SELECT ...
//   EXPLAIN (ANALYZE, VERBOSE, FORMAT JSON, ...) SELECT ...
//   EXPLAIN ANALYZE SELECT ...
//   EXPLAIN ANALYZE VERBOSE SELECT ...

function isExplainStatement(sql: string): boolean {
	return /^\s*EXPLAIN\b/i.test(sql);
}

/**
 * Strips the EXPLAIN keyword and all option tokens, returning the bare inner query.
 *
 * PostgreSQL supports two option styles:
 *   - Parenthesized: EXPLAIN (ANALYZE, VERBOSE, FORMAT JSON) SELECT ...
 *   - Bare keywords: EXPLAIN ANALYZE VERBOSE SELECT ...   (only ANALYZE and VERBOSE here)
 */
function stripExplainPrefix(sql: string): string {
	// 1. Strip "EXPLAIN"
	let s = sql.replace(/^\s*EXPLAIN\s*/i, "");
	// 2. Strip optional parenthesised options block: (ANALYZE, VERBOSE, FORMAT TEXT, ...)
	s = s.replace(/^\s*\([^)]*\)\s*/, "");
	// 3. Strip optional bare ANALYZE / VERBOSE (can appear in either order, up to twice)
	s = s.replace(/^\s*(?:ANALYZE|VERBOSE)\s*/gi, "");
	s = s.replace(/^\s*(?:ANALYZE|VERBOSE)\s*/gi, "");
	return s.trim();
}

// ─── Dangerous function scanner ────────────────────────────────────────────────

/**
 * Scans the SQL text for dangerous function calls.
 *
 * Uses `\bfn_name\s*(` rather than a plain substring match to:
 *   - avoid false positives on column/table names that contain the fn name as a prefix
 *     (e.g. "dblink_result" should not match "dblink")
 *   - require actual call syntax (the opening parenthesis)
 */
function findDangerousFunctions(sql: string): string[] {
	const found: string[] = [];
	for (const fn of DANGEROUS_FUNCTIONS) {
		if (new RegExp(`\\b${fn}\\s*\\(`, "i").test(sql)) {
			found.push(fn);
		}
	}
	return found;
}

// ─── Main validation ───────────────────────────────────────────────────────────

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

	// ── 1. Query length guard ───────────────────────────────────────────────────
	if (trimmedSql.length > MAX_QUERY_LENGTH) {
		report.errors.push(
			`Query exceeds the ${MAX_QUERY_LENGTH.toLocaleString()}-character limit.`,
		);
		return report;
	}

	// ── 2. Dangerous function check ─────────────────────────────────────────────
	// Runs before the first-keyword check so that `SELECT pg_read_file(...)` is
	// caught even though SELECT is an allowed first keyword.
	const dangerousFns = findDangerousFunctions(trimmedSql);
	if (dangerousFns.length > 0) {
		report.errors.push(
			`Blocked: restricted function(s) detected: ${dangerousFns.join(", ")}. ` +
				`These functions can access the filesystem, run remote queries, or tamper with session state.`,
		);
		return report;
	}

	// ── 3. First-keyword fast path ──────────────────────────────────────────────
	const firstKeyword = trimmedSql.match(/^\s*([a-zA-Z]+)/)?.[1]?.toUpperCase();
	if (firstKeyword && BLOCKED_FIRST_KEYWORDS.has(firstKeyword)) {
		report.statementType = firstKeyword.toLowerCase();
		report.errors.push(
			`Dangerous operation rejected: ${firstKeyword} is not permitted. ` +
				`qcp is read-only — only SELECT, WITH, and EXPLAIN are allowed.`,
		);
		return report;
	}

	// ── 4. EXPLAIN ──────────────────────────────────────────────────────────────
	// The inner query is validated via a recursive validateSql() call, so all
	// layers above (dangerous functions, keyword block, AST parse, LIMIT) still apply.
	if (isExplainStatement(trimmedSql)) {
		const innerSql = stripExplainPrefix(trimmedSql);
		if (!innerSql) {
			report.errors.push("EXPLAIN requires a statement.");
			return report;
		}
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
		// EXPLAIN does not return data rows — no LIMIT injection needed.
		report.processedSql = trimmedSql.replace(/;\s*$/, "");
		return report;
	}

	// ── 5. AST parse ────────────────────────────────────────────────────────────
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

	// ── Statement allowlist ─────────────────────────────────────────────────────
	if (!ALLOWED_STATEMENT_TYPES.has(stmtType)) {
		const label = DANGEROUS_STATEMENT_TYPES[stmtType];
		report.errors.push(
			label
				? `Dangerous operation rejected: ${label} is not permitted. qcp is read-only — only SELECT and WITH are allowed.`
				: `Statement type '${stmtType.toUpperCase()}' is not permitted. Only SELECT, WITH, and EXPLAIN are allowed.`,
		);
		return report;
	}

	report.allowedStatement = true;
	report.readOnly = true;

	// ── 6. LIMIT injection / clamping ───────────────────────────────────────────
	let processedSql = trimmedSql.replace(/;\s*$/, "");
	const currentLimit = extractTopLevelLimit(stmt);

	if (currentLimit === null) {
		processedSql = `${processedSql}\nLIMIT ${MAX_LIMIT}`;
		report.limitApplied = true;
		report.warnings.push(`LIMIT ${MAX_LIMIT} automatically applied.`);
	} else if (currentLimit > MAX_LIMIT) {
		processedSql = replaceTopLevelLimit(processedSql, currentLimit, MAX_LIMIT);
		report.warnings.push(
			`LIMIT reduced to ${MAX_LIMIT} (was ${currentLimit}).`,
		);
	}

	report.processedSql = processedSql;
	report.safe = true;
	return report;
}

// ─── LIMIT helpers ─────────────────────────────────────────────────────────────

/**
 * Returns the numeric value of the outermost LIMIT clause, or null if absent.
 *
 * For WITH statements the LIMIT lives on the final query (stmt.in), not on the
 * CTE definitions, so we recurse into `stmt.in`.
 *
 * Replaces the original two-function pair (statementHasLimit + extractLimitValue)
 * with a single function whose return type encodes both pieces of information.
 */
function extractTopLevelLimit(stmt: Statement): number | null {
	if (stmt.type === "select") {
		const s = stmt as unknown as { limit?: { limit?: { value?: unknown } } };
		const v = s.limit?.limit?.value;
		return typeof v === "number" ? v : null;
	}
	if (stmt.type === "with") {
		const inner = (stmt as unknown as { in?: Statement }).in;
		return inner ? extractTopLevelLimit(inner) : null;
	}
	return null;
}

/**
 * Replaces the outermost LIMIT clause in `sql` with `newLimit`.
 *
 * Why replace the *last* occurrence?
 * In any SQL text, subquery LIMIT clauses always appear before the outer
 * query's LIMIT. Replacing the last `LIMIT <oldLimit>` therefore targets the
 * outermost clause without clobbering limits inside subqueries.
 *
 * Fallback: if the literal value is not found (shouldn't normally happen if
 * extractTopLevelLimit returned it), strips all LIMIT clauses and appends
 * the clamped value — lossy for subqueries but always safe.
 */
function replaceTopLevelLimit(
	sql: string,
	oldLimit: number,
	newLimit: number,
): string {
	const re = new RegExp(`\\bLIMIT\\s+${oldLimit}\\b`, "gi");
	let lastIndex = -1;
	let lastMatchLen = 0;
	const matches = sql.matchAll(re);

	for (const m of matches) {
		lastIndex = m.index;
		lastMatchLen = m.length;
	}
	if (lastIndex === -1) {
		// Fallback — should not normally occur
		return `${sql.replace(/\bLIMIT\s+\d+\b/gi, "").trimEnd()}\nLIMIT ${newLimit}`;
	}
	return (
		sql.slice(0, lastIndex) +
		`LIMIT ${newLimit}` +
		sql.slice(lastIndex + lastMatchLen)
	);
}

// ─── Sensitive table detection ─────────────────────────────────────────────────

export function detectSensitiveTables(
	sql: string,
	patterns: string[],
): string[] {
	const lower = sql.toLowerCase();
	const found = patterns.filter((p) => lower.includes(p.toLowerCase()));
	return [...new Set(found)];
}

// ─── Approval reasons ──────────────────────────────────────────────────────────

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
