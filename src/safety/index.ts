/**
 * SQL Safety Module
 *
 * Uses pgsql-ast-parser v12 for AST-based validation.
 * Fail-safe: any parse error → reject.
 * EXPLAIN is handled with a pre-parse check + inner SELECT validation.
 */

import type {
	Expr,
	From,
	FromStatement,
	FromTable,
	QName,
	SelectFromStatement,
	SelectFromUnion,
	SelectStatement,
	Statement,
	WithStatement,
	WithStatementBinding,
} from "pgsql-ast-parser";
import { parse, toSql } from "pgsql-ast-parser";
import { z } from "zod";
import type {
	ApprovalReason,
	DatabaseSchema,
	PromptViolationReport,
	SafetyReport,
	SchemaTable,
	SecurityRequestContext,
	TenantIsolationReport,
} from "../types/index.js";

export * from "./policy.js";
export * from "./postgres-posture.js";
export * from "./privacy-policy.js";

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
const TENANT_COLUMNS = [
	"organization_id",
	"tenant_id",
	"org_id",
	"workspace_id",
	"account_id",
] as const;
const USER_COLUMNS = ["user_id", "owner_id"] as const;
const SYSTEM_SCHEMAS = new Set(["information_schema", "pg_catalog"]);

export const securityRequestContextSchema = z.object({
	tenantId: z.string().min(1),
	userId: z.string().min(1),
});

const SECURITY_PROMPT_PATTERNS = [
	/\b(ignore|override|bypass|disable)\b.{0,80}\b(safety|security|policy|guardrail|approval|validation|tenant|rls)\b/i,
	/\b(jailbreak|prompt injection|system prompt|developer message)\b/i,
	/\b(escalate|grant|revoke)\b.{0,80}\b(privilege|permission|role|admin|superuser|access)\b/i,
	/\b(steal|exfiltrate|leak)\b.{0,80}\b(credentials?|passwords?|tokens?|secrets?|keys?)\b/i,
] as const;

const SAFETY_PROMPT_PATTERNS = [
	/\b(drop|delete|truncate|alter|update|insert|create|replace|merge|copy)\b/i,
	/\b(remove|erase|destroy|wipe|purge)\b.{0,80}\b(table|tables|row|rows|record|records|data|database|schema)\b/i,
	/\b(change|modify|set)\b.{0,80}\b(row|rows|record|records|email|password|role|status|database|table|schema)\b/i,
] as const;

const PRIVACY_PROMPT_PATTERNS = [
	/\b(show|list|dump|export|reveal|get|fetch)\b.{0,100}\b(emails?|phone numbers?|ssn|social security|api keys?|tokens?|secrets?|passwords?|credentials?)\b/i,
	/\b(pii|personal data|private data|sensitive data)\b/i,
	/\b(all users?|customers?|employees?)\b.{0,100}\b(emails?|phone numbers?|addresses?|ssn|tokens?|secrets?|passwords?)\b/i,
] as const;

export function classifyPromptViolation(
	prompt: string,
): PromptViolationReport | null {
	const normalized = prompt.trim();
	if (!normalized) return null;

	if (SECURITY_PROMPT_PATTERNS.some((pattern) => pattern.test(normalized))) {
		return {
			category: "security",
			title: "Security violation",
			message: "Request rejected — security policy violation.",
			detail:
				"qcp cannot help bypass safety controls, escalate privileges, expose credentials, or weaken tenant boundaries.",
		};
	}

	if (SAFETY_PROMPT_PATTERNS.some((pattern) => pattern.test(normalized))) {
		return {
			category: "safety",
			title: "Safety violation",
			message: "Request rejected — safety policy violation.",
			detail:
				"qcp is read-only and cannot generate or execute SQL that modifies data, changes schema, or performs destructive database operations.",
		};
	}

	if (PRIVACY_PROMPT_PATTERNS.some((pattern) => pattern.test(normalized))) {
		return {
			category: "privacy",
			title: "Privacy violation",
			message: "Request rejected — privacy policy violation.",
			detail:
				"qcp cannot directly expose personal data, credentials, tokens, secrets, or other sensitive fields. Ask for aggregate or non-sensitive results instead.",
		};
	}

	return null;
}

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

	const readOnlyViolation = findNonReadOnlyStatement(stmt);
	if (readOnlyViolation) {
		report.errors.push(
			`Dangerous operation rejected: ${readOnlyViolation} is not permitted inside this query. ` +
				`qcp is read-only — only SELECT and WITH are allowed.`,
		);
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

function findNonReadOnlyStatement(stmt: Statement): string | null {
	if (stmt.type === "select" || stmt.type === "values") return null;
	if (stmt.type === "union" || stmt.type === "union all") {
		return (
			findNonReadOnlyStatement(stmt.left) ??
			findNonReadOnlyStatement(stmt.right)
		);
	}
	if (stmt.type === "with") {
		for (const binding of stmt.bind) {
			const bindingViolation = findNonReadOnlyBinding(binding.statement);
			if (bindingViolation) return bindingViolation;
		}
		return findNonReadOnlyBinding(stmt.in);
	}
	if (stmt.type === "with recursive") return "WITH RECURSIVE";

	return DANGEROUS_STATEMENT_TYPES[stmt.type] ?? stmt.type.toUpperCase();
}

function findNonReadOnlyBinding(binding: WithStatementBinding): string | null {
	if (
		binding.type === "select" ||
		binding.type === "union" ||
		binding.type === "union all" ||
		binding.type === "values" ||
		binding.type === "with"
	) {
		return findNonReadOnlyStatement(binding);
	}

	return DANGEROUS_STATEMENT_TYPES[binding.type] ?? binding.type.toUpperCase();
}

// ─── Tenant isolation ─────────────────────────────────────────────────────────

interface TableScope {
	alias: string;
	tableId: string;
	tenantColumn?: string;
	userColumn?: string;
}

interface TenantIsolationState {
	readonly schema: DatabaseSchema;
	readonly context: SecurityRequestContext;
	readonly tableIndex: Map<string, SchemaTable[]>;
	readonly errors: string[];
	readonly warnings: string[];
	readonly injectedPredicates: string[];
	readonly scopedTables: string[];
}

export function enforceTenantIsolation(
	sql: string,
	schema: DatabaseSchema,
	context: SecurityRequestContext,
): TenantIsolationReport {
	const report: TenantIsolationReport = {
		safe: false,
		errors: [],
		warnings: [],
		processedSql: sql.trim(),
		injectedPredicates: [],
		scopedTables: [],
	};

	const contextResult = securityRequestContextSchema.safeParse(context);
	if (!contextResult.success) {
		report.errors.push("Trusted tenant context is required.");
		return report;
	}

	let statements: Statement[];
	try {
		statements = parse(sql.trim(), { locationTracking: false });
	} catch {
		report.errors.push("SQL parsing failed during tenant isolation.");
		return report;
	}

	if (statements.length !== 1) {
		report.errors.push("Tenant isolation requires exactly one SQL statement.");
		return report;
	}

	const statement = statements[0];
	const readOnlyViolation = findNonReadOnlyStatement(statement);
	if (readOnlyViolation) {
		report.errors.push(
			`Tenant isolation rejected non-read-only statement: ${readOnlyViolation}.`,
		);
		return report;
	}

	const state: TenantIsolationState = {
		schema,
		context: contextResult.data,
		tableIndex: buildTableIndex(schema),
		errors: report.errors,
		warnings: report.warnings,
		injectedPredicates: report.injectedPredicates,
		scopedTables: report.scopedTables,
	};

	const scopedStatement = scopeStatement(statement, state, new Set());
	if (!scopedStatement || state.errors.length > 0) {
		return report;
	}

	report.processedSql = toSql.statement(scopedStatement);
	report.safe = true;
	return report;
}

function buildTableIndex(schema: DatabaseSchema): Map<string, SchemaTable[]> {
	const index = new Map<string, SchemaTable[]>();
	for (const table of schema.tables) {
		const fullName = tableKey(table.schema, table.name);
		index.set(fullName, [table]);

		const byName = index.get(table.name.toLowerCase()) ?? [];
		byName.push(table);
		index.set(table.name.toLowerCase(), byName);
	}
	return index;
}

function scopeStatement(
	statement: Statement,
	state: TenantIsolationState,
	cteNames: Set<string>,
): Statement | null {
	if (statement.type === "with") {
		return scopeWithStatement(statement, state, cteNames);
	}
	if (
		statement.type === "select" ||
		statement.type === "union" ||
		statement.type === "union all" ||
		statement.type === "values"
	) {
		return scopeSelectStatement(statement, state, cteNames);
	}

	state.errors.push(
		`Tenant isolation supports SELECT and WITH only, not ${statement.type}.`,
	);
	return null;
}

function scopeWithStatement(
	statement: WithStatement,
	state: TenantIsolationState,
	parentCteNames: Set<string>,
): WithStatement | null {
	const cteNames = new Set(parentCteNames);
	for (const binding of statement.bind) {
		cteNames.add(binding.alias.name.toLowerCase());
	}

	const bindings = statement.bind.map((binding) => {
		const scoped = scopeWithBinding(binding.statement, state, cteNames);
		return scoped ? { ...binding, statement: scoped } : binding;
	});
	const scopedIn = scopeWithBinding(statement.in, state, cteNames);
	if (!scopedIn) return null;

	return {
		...statement,
		bind: bindings,
		in: scopedIn,
	};
}

function scopeWithBinding(
	binding: WithStatementBinding,
	state: TenantIsolationState,
	cteNames: Set<string>,
): WithStatementBinding | null {
	if (
		binding.type === "select" ||
		binding.type === "union" ||
		binding.type === "union all" ||
		binding.type === "values" ||
		binding.type === "with"
	) {
		return scopeSelectStatement(binding, state, cteNames);
	}

	state.errors.push(
		`Tenant isolation rejected non-read-only WITH binding: ${binding.type}.`,
	);
	return null;
}

function scopeSelectStatement(
	statement: SelectStatement,
	state: TenantIsolationState,
	cteNames: Set<string>,
): SelectStatement | null {
	switch (statement.type) {
		case "with":
			return scopeWithStatement(statement, state, cteNames);
		case "with recursive":
			state.errors.push("WITH RECURSIVE is not supported by tenant isolation.");
			return null;
		case "union":
		case "union all":
			return scopeUnionStatement(statement, state, cteNames);
		case "values":
			return statement;
		case "select":
			return scopeSelectFromStatement(statement, state, cteNames);
	}
}

function scopeUnionStatement(
	statement: SelectFromUnion,
	state: TenantIsolationState,
	cteNames: Set<string>,
): SelectFromUnion | null {
	const left = scopeSelectStatement(statement.left, state, cteNames);
	const right = scopeSelectStatement(statement.right, state, cteNames);
	if (!left || !right) return null;

	return {
		...statement,
		left,
		right,
	};
}

function scopeSelectFromStatement(
	statement: SelectFromStatement,
	state: TenantIsolationState,
	cteNames: Set<string>,
): SelectFromStatement | null {
	if (containsNestedSelect(statement)) {
		state.errors.push(
			"Nested subqueries are not supported by tenant isolation.",
		);
		return null;
	}

	const from = statement.from?.map((item) => scopeFrom(item, state, cteNames));
	if (state.errors.length > 0) return null;

	const scopes = (from ?? []).flatMap((item) => collectTableScopes(item));
	let where = statement.where;
	for (const scope of scopes) {
		const conflict = findConflictingScopePredicate(where, scope, state.context);
		if (conflict) {
			state.errors.push(conflict);
			return null;
		}

		const predicates = buildScopePredicates(scope, state.context);
		for (const predicate of predicates) {
			where = andExpr(where, predicate.expr);
			state.injectedPredicates.push(predicate.label);
		}
		state.scopedTables.push(scope.tableId);
	}

	return {
		...statement,
		from,
		where,
	};
}

function scopeFrom(
	from: From,
	state: TenantIsolationState,
	cteNames: Set<string>,
): From {
	assertSafeJoin(from, state);

	if (from.type === "call") {
		state.errors.push("Table functions are not supported by tenant isolation.");
		return from;
	}

	if (from.lateral) {
		state.errors.push("LATERAL queries are not supported by tenant isolation.");
		return from;
	}

	if (from.type === "statement") {
		const scopedStatement = scopeSelectStatement(
			from.statement,
			state,
			cteNames,
		);
		return scopedStatement
			? ({
					...from,
					statement: scopedStatement,
				} satisfies FromStatement)
			: from;
	}

	if (isCteReference(from, cteNames)) return from;

	const scope = resolveTableScope(from, state);
	return scope
		? ({
				...from,
				__qcpScope: scope,
			} as FromTableWithScope)
		: from;
}

interface FromTableWithScope extends FromTable {
	__qcpScope: TableScope;
}

function collectTableScopes(from: From): TableScope[] {
	const scope = (from as Partial<FromTableWithScope>).__qcpScope;
	return scope ? [scope] : [];
}

function assertSafeJoin(from: From, state: TenantIsolationState): void {
	const joinType = from.join?.type;
	if (!joinType) return;
	if (joinType === "INNER JOIN" || joinType === "CROSS JOIN") return;
	state.errors.push(`${joinType} is not supported by tenant isolation.`);
}

function isCteReference(from: FromTable, cteNames: Set<string>): boolean {
	return !from.name.schema && cteNames.has(from.name.name.toLowerCase());
}

function resolveTableScope(
	from: FromTable,
	state: TenantIsolationState,
): TableScope | null {
	const table = resolveSchemaTable(from.name, state);
	if (!table) return null;

	const columns = new Set(
		table.columns.map((column) => column.name.toLowerCase()),
	);
	const tenantColumn = TENANT_COLUMNS.find((column) => columns.has(column));
	const userColumn = USER_COLUMNS.find((column) => columns.has(column));

	if (!tenantColumn && !userColumn) {
		state.errors.push(
			`Table ${formatTableId(table)} has no supported tenant or user scope column.`,
		);
		return null;
	}

	return {
		alias: from.name.alias ?? from.name.name,
		tableId: formatTableId(table),
		tenantColumn,
		userColumn,
	};
}

function resolveSchemaTable(
	name: QName,
	state: TenantIsolationState,
): SchemaTable | null {
	if (name.schema && SYSTEM_SCHEMAS.has(name.schema.toLowerCase())) {
		return null;
	}

	const key = name.schema
		? tableKey(name.schema, name.name)
		: name.name.toLowerCase();
	const matches = state.tableIndex.get(key) ?? [];

	if (matches.length === 1) return matches[0];
	if (matches.length > 1) {
		state.errors.push(
			`Table ${name.name} is ambiguous across schemas; qualify it explicitly.`,
		);
		return null;
	}

	state.errors.push(
		`Unknown table rejected by tenant isolation: ${name.name}.`,
	);
	return null;
}

function buildScopePredicates(
	scope: TableScope,
	context: SecurityRequestContext,
): Array<{ expr: Expr; label: string }> {
	const predicates: Array<{ expr: Expr; label: string }> = [];

	if (scope.tenantColumn) {
		predicates.push({
			expr: equalityExpr(scope.alias, scope.tenantColumn, context.tenantId),
			label: `${scope.tableId}.${scope.tenantColumn} = [tenantId]`,
		});
	}
	if (scope.userColumn) {
		predicates.push({
			expr: equalityExpr(scope.alias, scope.userColumn, context.userId),
			label: `${scope.tableId}.${scope.userColumn} = [userId]`,
		});
	}

	return predicates;
}

function equalityExpr(table: string, column: string, value: string): Expr {
	return {
		type: "binary",
		op: "=",
		left: {
			type: "ref",
			table: { name: table },
			name: column,
		},
		right: {
			type: "string",
			value,
		},
	};
}

function andExpr(left: Expr | null | undefined, right: Expr): Expr {
	if (!left) return right;
	return {
		type: "binary",
		op: "AND",
		left,
		right,
	};
}

function findConflictingScopePredicate(
	expr: Expr | null | undefined,
	scope: TableScope,
	context: SecurityRequestContext,
): string | null {
	if (!expr) return null;

	if (expr.type === "binary") {
		const directConflict = scopePredicateConflict(expr, scope, context);
		if (directConflict) return directConflict;
		return (
			findConflictingScopePredicate(expr.left, scope, context) ??
			findConflictingScopePredicate(expr.right, scope, context)
		);
	}
	if (expr.type === "unary") {
		return findConflictingScopePredicate(expr.operand, scope, context);
	}
	if (expr.type === "ternary") {
		return (
			findConflictingScopePredicate(expr.value, scope, context) ??
			findConflictingScopePredicate(expr.lo, scope, context) ??
			findConflictingScopePredicate(expr.hi, scope, context)
		);
	}
	if (expr.type === "case") {
		for (const when of expr.whens) {
			const conflict =
				findConflictingScopePredicate(when.when, scope, context) ??
				findConflictingScopePredicate(when.value, scope, context);
			if (conflict) return conflict;
		}
		return findConflictingScopePredicate(expr.else, scope, context);
	}
	if (expr.type === "list" || expr.type === "array") {
		for (const item of expr.expressions) {
			const conflict = findConflictingScopePredicate(item, scope, context);
			if (conflict) return conflict;
		}
	}
	if (expr.type === "cast") {
		return findConflictingScopePredicate(expr.operand, scope, context);
	}

	return null;
}

function scopePredicateConflict(
	expr: Extract<Expr, { type: "binary" }>,
	scope: TableScope,
	context: SecurityRequestContext,
): string | null {
	if (expr.op !== "=") return null;

	const conflict =
		refLiteralConflict(expr.left, expr.right, scope, context) ??
		refLiteralConflict(expr.right, expr.left, scope, context);

	return conflict
		? `Query attempted to override trusted ${conflict} scope.`
		: null;
}

function refLiteralConflict(
	ref: Expr,
	literal: Expr,
	scope: TableScope,
	context: SecurityRequestContext,
): "tenant" | "user" | null {
	if (ref.type !== "ref") return null;
	const tableName = ref.table?.name.toLowerCase();
	if (tableName && tableName !== scope.alias.toLowerCase()) return null;

	const literalValue = literalToString(literal);
	if (literalValue === null) return null;

	if (
		scope.tenantColumn &&
		ref.name.toLowerCase() === scope.tenantColumn &&
		literalValue !== context.tenantId
	) {
		return "tenant";
	}
	if (
		scope.userColumn &&
		ref.name.toLowerCase() === scope.userColumn &&
		literalValue !== context.userId
	) {
		return "user";
	}
	return null;
}

function literalToString(expr: Expr): string | null {
	if (expr.type === "string") return expr.value;
	if (expr.type === "integer" || expr.type === "numeric") {
		return String(expr.value);
	}
	if (expr.type === "cast") return literalToString(expr.operand);
	return null;
}

function containsNestedSelect(statement: SelectFromStatement): boolean {
	const expressions = [
		...(statement.columns?.map((column) => column.expr) ?? []),
		statement.where,
		statement.having,
		...(statement.groupBy ?? []),
		...(statement.orderBy?.map((orderBy) => orderBy.by) ?? []),
	].filter((expr): expr is Expr => !!expr);

	return expressions.some(exprContainsSelect);
}

function exprContainsSelect(expr: Expr): boolean {
	if (
		expr.type === "select" ||
		expr.type === "with" ||
		expr.type === "union" ||
		expr.type === "union all" ||
		expr.type === "values" ||
		expr.type === "array select"
	) {
		return true;
	}
	if (expr.type === "binary") {
		return exprContainsSelect(expr.left) || exprContainsSelect(expr.right);
	}
	if (expr.type === "unary") return exprContainsSelect(expr.operand);
	if (expr.type === "ternary") {
		return (
			exprContainsSelect(expr.value) ||
			exprContainsSelect(expr.lo) ||
			exprContainsSelect(expr.hi)
		);
	}
	if (expr.type === "cast") return exprContainsSelect(expr.operand);
	if (expr.type === "case") {
		return (
			expr.whens.some(
				(when) =>
					exprContainsSelect(when.when) || exprContainsSelect(when.value),
			) || (expr.else ? exprContainsSelect(expr.else) : false)
		);
	}
	if (expr.type === "call") return expr.args.some(exprContainsSelect);
	if (expr.type === "list" || expr.type === "array") {
		return expr.expressions.some(exprContainsSelect);
	}
	if (expr.type === "member") return exprContainsSelect(expr.operand);
	if (expr.type === "arrayIndex") {
		return exprContainsSelect(expr.array) || exprContainsSelect(expr.index);
	}
	if (expr.type === "overlay") {
		return (
			exprContainsSelect(expr.value) ||
			exprContainsSelect(expr.placing) ||
			exprContainsSelect(expr.from) ||
			(expr.for ? exprContainsSelect(expr.for) : false)
		);
	}
	if (expr.type === "substring") {
		return (
			exprContainsSelect(expr.value) ||
			(expr.from ? exprContainsSelect(expr.from) : false) ||
			(expr.for ? exprContainsSelect(expr.for) : false)
		);
	}

	return false;
}

function tableKey(schema: string, name: string): string {
	return `${schema.toLowerCase()}.${name.toLowerCase()}`;
}

function formatTableId(table: SchemaTable): string {
	return table.schema === "public"
		? table.name
		: `${table.schema}.${table.name}`;
}

// ─── Privacy scrubbing and error hygiene ──────────────────────────────────────

const SENSITIVE_STRING_PATTERNS: Array<[RegExp, string]> = [
	[/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]"],
	[
		/\b(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/g,
		"[REDACTED_PHONE]",
	],
	[/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED_SSN]"],
	[
		/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
		"[REDACTED_TOKEN]",
	],
	[/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi, "Bearer [REDACTED_TOKEN]"],
	[
		/\b(api[_-]?key|token|secret|password)(["'\s:=]+)([A-Za-z0-9._~+/=-]{8,})\b/gi,
		"$1$2[REDACTED_SECRET]",
	],
	[/\b[A-Za-z0-9_-]{32,}\b/g, "[REDACTED_SECRET]"],
];

export function sanitizeSensitiveData<T>(value: T): T {
	return sanitizeUnknown(value) as T;
}

function sanitizeUnknown(value: unknown): unknown {
	if (typeof value === "string") return sanitizeString(value);
	if (Array.isArray(value)) return value.map((item) => sanitizeUnknown(item));
	if (isPlainRecord(value)) {
		const sanitized: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			sanitized[key] = sanitizeUnknown(item);
		}
		return sanitized;
	}
	return value;
}

function sanitizeString(value: string): string {
	return SENSITIVE_STRING_PATTERNS.reduce(
		(current, [pattern, replacement]) => current.replace(pattern, replacement),
		value,
	);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		(Object.getPrototypeOf(value) === Object.prototype ||
			Object.getPrototypeOf(value) === null)
	);
}

export function sanitizeDatabaseError(_error: unknown): string {
	return "Database query failed. The request was not completed.";
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

export function requiresSensitiveApproval(
	sql: string,
	report: SafetyReport,
	sensitivePatterns: string[],
): boolean {
	return getApprovalReasons(sql, report, sensitivePatterns).some(
		(reason) => reason.type === "sensitive_table",
	);
}

export function safetyReportToJson(report: SafetyReport) {
	return {
		readOnly: report.readOnly,
		allowedStatement: report.allowedStatement,
		limitApplied: report.limitApplied,
	};
}
