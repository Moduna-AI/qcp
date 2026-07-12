import { parse } from "pgsql-ast-parser";
import type {
	DatabaseSchema,
	PostgresPrivacyPolicy,
	PrivacySafetyFinding,
	SafetyReport,
} from "@/types/index.js";

const DEFAULT_SAFE_FUNCTIONS = new Set([
	"abs",
	"avg",
	"ceil",
	"ceiling",
	"coalesce",
	"count",
	"date_part",
	"date_trunc",
	"extract",
	"floor",
	"greatest",
	"least",
	"length",
	"lower",
	"max",
	"min",
	"nullif",
	"round",
	"sum",
	"trim",
	"upper",
]);

const SENSITIVE_COLUMN_PATTERN =
	/(?:^|_)(?:address|api_?key|birth|card|credential|dob|email|health|medical|password|phone|secret|ssn|social_security|token)(?:$|_)/i;
const UNSAFE_EXPLAIN_PATTERN =
	/^\s*EXPLAIN\s*(?:\([^)]*\bANALYZE\b[^)]*\)|ANALYZE\b)/i;
const UNSAFE_CLAUSE_PATTERN =
	/\bFOR\s+(?:UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)\b/i;
const AGGREGATE_FUNCTIONS = new Set(["avg", "count", "max", "min", "sum"]);

export interface PrivacyPolicyEvaluation {
	readonly safe: boolean;
	readonly findings: PrivacySafetyFinding[];
}

export function defaultPostgresPrivacyPolicy(): PostgresPrivacyPolicy {
	return {
		sensitiveColumns: [],
		allowedSensitiveViews: [],
		safeFunctions: [],
		minimumCohortSize: 10,
	};
}

export function evaluatePostgresPrivacyPolicy(input: {
	readonly sql: string;
	readonly schema: DatabaseSchema;
	readonly policy?: PostgresPrivacyPolicy;
}): PrivacyPolicyEvaluation {
	const policy = input.policy ?? defaultPostgresPrivacyPolicy();
	const findings: PrivacySafetyFinding[] = [];
	const lowerSql = input.sql.toLowerCase();
	const configuredSensitiveNames = [
		...policy.sensitiveColumns.map(normalizeObjectName),
		...input.schema.tables.flatMap((table) =>
			table.columns
				.filter((column) => SENSITIVE_COLUMN_PATTERN.test(column.name))
				.map((column) => column.name.toLowerCase()),
		),
	];
	const explicitlyTrustedView = policy.allowedSensitiveViews.some((view) =>
		lowerSql.includes(view.toLowerCase()),
	);
	if (
		!explicitlyTrustedView &&
		configuredSensitiveNames.some((column) => lowerSql.includes(column)) &&
		/\b(?:avg|count|max|min|sum)\s*\(/i.test(input.sql) &&
		!hasMinimumCohort(input.sql, policy.minimumCohortSize)
	) {
		findings.push({
			type: "minimum_cohort",
			detail: `Sensitive aggregates require HAVING COUNT(*) >= ${policy.minimumCohortSize}.`,
			object: String(policy.minimumCohortSize),
		});
	}

	if (UNSAFE_EXPLAIN_PATTERN.test(input.sql)) {
		findings.push({
			type: "unsafe_clause",
			detail: "EXPLAIN ANALYZE is not permitted because it executes the query.",
			object: "EXPLAIN ANALYZE",
		});
	}
	if (UNSAFE_CLAUSE_PATTERN.test(input.sql)) {
		findings.push({
			type: "unsafe_clause",
			detail: "Row-locking SELECT clauses are not permitted.",
			object: "FOR UPDATE/SHARE",
		});
	}

	const innerSql = stripExplain(input.sql);
	let ast: unknown;
	try {
		ast = parse(innerSql, { locationTracking: false });
	} catch {
		return { safe: findings.length === 0, findings };
	}

	const functions = collectAstNames(ast, "call");
	const safeFunctions = new Set([
		...DEFAULT_SAFE_FUNCTIONS,
		...policy.safeFunctions.map(normalizeObjectName),
	]);
	for (const fn of functions) {
		const normalized = normalizeObjectName(fn);
		if (!safeFunctions.has(normalized)) {
			findings.push({
				type: "unsafe_function",
				detail: `PostgreSQL function '${fn}' is not in the configured safe-function allowlist.`,
				object: fn,
			});
		}
	}

	const sensitive = sensitiveColumnNames(input.schema, policy);
	const trustedViews = new Set(
		policy.allowedSensitiveViews.map(normalizeObjectName),
	);
	const referencedTables = collectReferencedTables(ast);
	const referencedColumns = collectReferencedColumns(ast);
	const hasSensitiveWildcard =
		referencedColumns.has("*") &&
		referencedTables.some(
			(table) =>
				!trustedViews.has(normalizeObjectName(table)) &&
				tableHasSensitiveColumn(input.schema, table, sensitive),
		);
	const onlyTrustedViews =
		referencedTables.length > 0 &&
		referencedTables.every((table) =>
			trustedViews.has(normalizeObjectName(table)),
		);
	const sensitiveUsage = onlyTrustedViews
		? { raw: [], aggregate: [] }
		: collectSensitiveUsage(ast, sensitive);
	const sensitiveReferencedColumns = [...referencedColumns].filter((column) =>
		sensitive.has(normalizeObjectName(column)),
	);
	const aggregateSensitiveColumns =
		sensitiveUsage.aggregate.length > 0
			? sensitiveUsage.aggregate
			: sensitiveUsage.raw.length === 0 &&
					[...functions].some((fn) =>
						AGGREGATE_FUNCTIONS.has(normalizeObjectName(fn)),
					)
				? sensitiveReferencedColumns
				: [];
	if (hasSensitiveWildcard) {
		findings.push({
			type: "sensitive_column",
			detail:
				"Wildcard selection from a table containing sensitive columns is not permitted.",
			object: "*",
		});
	}

	if (sensitiveUsage.raw.length > 0) {
		for (const column of sensitiveUsage.raw) {
			findings.push({
				type: "sensitive_column",
				detail: `Raw access to sensitive column '${column}' is not permitted. Use an approved masked view or a cohort-protected aggregate.`,
				object: column,
			});
		}
	} else if (
		aggregateSensitiveColumns.length > 0 &&
		!isCohortProtected(input.sql, policy.minimumCohortSize, functions)
	) {
		findings.push({
			type: "minimum_cohort",
			detail: `Sensitive aggregates require HAVING COUNT(*) >= ${policy.minimumCohortSize}.`,
			object: String(policy.minimumCohortSize),
		});
	}

	return { safe: findings.length === 0, findings };
}

export function applyPrivacyEvaluation(
	report: SafetyReport,
	evaluation: PrivacyPolicyEvaluation,
): SafetyReport {
	if (evaluation.safe) return { ...report, privacyFindings: [] };
	return {
		...report,
		safe: false,
		privacyFindings: evaluation.findings,
		errors: [
			...report.errors,
			...evaluation.findings.map((finding) => finding.detail),
		],
	};
}

function stripExplain(sql: string): string {
	return sql.replace(/^\s*EXPLAIN\s*(?:\([^)]*\))?\s*/i, "").trim();
}

function normalizeObjectName(value: string): string {
	return (
		value.replace(/"/g, "").split(".").at(-1)?.toLowerCase() ??
		value.toLowerCase()
	);
}

function sensitiveColumnNames(
	schema: DatabaseSchema,
	policy: PostgresPrivacyPolicy,
): Set<string> {
	const result = new Set(policy.sensitiveColumns.map(normalizeObjectName));
	for (const table of schema.tables) {
		for (const column of table.columns) {
			if (SENSITIVE_COLUMN_PATTERN.test(column.name))
				result.add(column.name.toLowerCase());
		}
	}
	return result;
}

function tableHasSensitiveColumn(
	schema: DatabaseSchema,
	tableName: string,
	sensitive: Set<string>,
): boolean {
	const normalized = normalizeObjectName(tableName);
	return schema.tables.some(
		(table) =>
			normalizeObjectName(table.name) === normalized &&
			table.columns.some((column) => sensitive.has(column.name.toLowerCase())),
	);
}

function isCohortProtected(
	sql: string,
	minimum: number,
	functions: Set<string>,
): boolean {
	return (
		[...functions].some((fn) =>
			AGGREGATE_FUNCTIONS.has(normalizeObjectName(fn)),
		) && hasMinimumCohort(sql, minimum)
	);
}

function collectSensitiveUsage(
	value: unknown,
	sensitive: Set<string>,
): { raw: string[]; aggregate: string[] } {
	const raw = new Set<string>();
	const aggregate = new Set<string>();
	const visit = (node: unknown, insideAggregate: boolean): void => {
		if (Array.isArray(node)) {
			for (const item of node) visit(item, insideAggregate);
			return;
		}
		if (!isRecord(node)) return;
		const fn =
			node.type === "call" &&
			isRecord(node.function) &&
			typeof node.function.name === "string"
				? normalizeObjectName(node.function.name)
				: undefined;
		const nestedAggregate =
			insideAggregate || (fn !== undefined && AGGREGATE_FUNCTIONS.has(fn));
		if (
			node.type === "ref" &&
			typeof node.name === "string" &&
			sensitive.has(normalizeObjectName(node.name))
		) {
			if (insideAggregate) aggregate.add(node.name);
			else raw.add(node.name);
		}
		for (const child of Object.values(node)) visit(child, nestedAggregate);
	};
	visit(value, false);
	return { raw: [...raw], aggregate: [...aggregate] };
}

function hasMinimumCohort(sql: string, minimum: number): boolean {
	const match = sql.match(/\bHAVING\s+COUNT\s*\(\s*\*\s*\)\s*>=\s*(\d+)/i);
	return match?.[1] !== undefined && Number(match[1]) >= minimum;
}

function collectAstNames(value: unknown, nodeType: string): Set<string> {
	const result = new Set<string>();
	walk(value, (record) => {
		if (record.type !== nodeType) return;
		const fn = record.function;
		if (isRecord(fn) && typeof fn.name === "string") result.add(fn.name);
		if (typeof fn === "string") result.add(fn);
	});
	return result;
}

function collectReferencedTables(value: unknown): string[] {
	const result = new Set<string>();
	walk(value, (record) => {
		if (record.type !== "table") return;
		const name = record.name;
		if (!isRecord(name) || typeof name.name !== "string") return;
		result.add(
			typeof name.schema === "string"
				? `${name.schema}.${name.name}`
				: name.name,
		);
	});
	return [...result];
}

function collectReferencedColumns(value: unknown): Set<string> {
	const result = new Set<string>();
	walk(value, (record) => {
		if (record.type === "ref" && typeof record.name === "string")
			result.add(record.name);
		if (record.type === "ref" && record.name === "*") result.add("*");
	});
	return result;
}

function walk(
	value: unknown,
	visitor: (record: Record<string, unknown>) => void,
): void {
	if (Array.isArray(value)) {
		for (const item of value) walk(item, visitor);
		return;
	}
	if (!isRecord(value)) return;
	visitor(value);
	for (const child of Object.values(value)) walk(child, visitor);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}
