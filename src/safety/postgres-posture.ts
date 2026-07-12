import type {
	DatabaseSchema,
	PostgresPrivacyPolicy,
	PostgresPrivacyPostureFinding,
	PostgresPrivacyPostureReport,
	QueryResult,
} from "@/types/index.js";

type PostgresPostureQueryExecutor = (
	databaseUrl: string,
	sql: string,
) => Promise<QueryResult>;

const POSTURE_QUERY = `
SELECT current_user AS role_name,
       r.rolsuper,
       r.rolbypassrls,
       COALESCE(json_agg(json_build_object(
         'schema', n.nspname,
         'table', c.relname,
         'kind', c.relkind,
         'owner', pg_get_userbyid(c.relowner),
         'rls', c.relrowsecurity,
		 'forceRls', c.relforcerowsecurity,
		 'selectableColumns', (SELECT COALESCE(json_agg(a.attname), '[]'::json)
		   FROM pg_attribute a
		   WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
		     AND has_column_privilege(current_user, c.oid, a.attname, 'SELECT'))
       )) FILTER (WHERE c.oid IS NOT NULL), '[]'::json) AS relations
FROM pg_roles r
LEFT JOIN pg_class c ON c.relkind IN ('r', 'p', 'v', 'm')
LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
WHERE r.rolname = current_user
GROUP BY r.rolsuper, r.rolbypassrls`;

export async function auditPostgresPrivacyPosture(input: {
	readonly databaseUrl: string;
	readonly queryExecutor: PostgresPostureQueryExecutor;
	readonly schema?: DatabaseSchema;
	readonly privacyPolicy?: PostgresPrivacyPolicy;
}): Promise<PostgresPrivacyPostureReport> {
	const result = await input.queryExecutor(input.databaseUrl, POSTURE_QUERY);
	const row = result.rows[0] ?? {};
	const role = typeof row.role_name === "string" ? row.role_name : "unknown";
	const findings: PostgresPrivacyPostureFinding[] = [];

	if (row.rolsuper === true) {
		findings.push(
			finding(
				"Role privileges",
				"critical",
				"The qcp database role is a PostgreSQL superuser.",
				"Use a dedicated least-privilege role with SELECT access only.",
			),
		);
	}
	if (row.rolbypassrls === true) {
		findings.push(
			finding(
				"Row-level security",
				"critical",
				"The qcp database role can bypass row-level security.",
				"Remove BYPASSRLS and use FORCE ROW LEVEL SECURITY where table owners must also be scoped.",
			),
		);
	}

	for (const relation of parseRelations(row.relations)) {
		const sensitiveColumns = classifiedSensitiveColumns(
			input.schema,
			input.privacyPolicy,
			relation.schema,
			relation.table,
		);
		const exposedColumns = relation.selectableColumns.filter((column) =>
			sensitiveColumns.has(column.toLowerCase()),
		);
		const trustedView = input.privacyPolicy?.allowedSensitiveViews.some(
			(view) =>
				view.toLowerCase() ===
				`${relation.schema}.${relation.table}`.toLowerCase(),
		);
		if (exposedColumns.length > 0 && !trustedView) {
			findings.push(
				finding(
					"Sensitive column privileges",
					"critical",
					`${relation.schema}.${relation.table} grants the qcp role SELECT on classified sensitive columns: ${exposedColumns.join(", ")}.`,
					"Revoke raw column access and grant SELECT on a reviewed masked or projection view instead.",
				),
			);
		}
		if ((relation.kind === "r" || relation.kind === "p") && !relation.rls) {
			findings.push(
				finding(
					"Row-level security",
					"warning",
					`${relation.schema}.${relation.table} does not enable RLS.`,
					"Enable and test RLS for multi-tenant or user-scoped data.",
				),
			);
		} else if (relation.rls && !relation.forceRls && relation.owner === role) {
			findings.push(
				finding(
					"Forced row-level security",
					"warning",
					`${relation.schema}.${relation.table} is owned by the qcp role without FORCE RLS.`,
					"Use a non-owner reader role or enable FORCE ROW LEVEL SECURITY.",
				),
			);
		}
	}

	if (findings.length === 0) {
		findings.push(
			finding(
				"Privacy posture",
				"info",
				"No high-confidence role or RLS issues were detected.",
				"Continue using restricted views, column grants, masking, encryption, and periodic privilege review.",
			),
		);
	}
	return { role, findings, checkedAt: new Date().toISOString() };
}

function finding(
	check: string,
	severity: PostgresPrivacyPostureFinding["severity"],
	detail: string,
	remediation: string,
): PostgresPrivacyPostureFinding {
	return { check, severity, detail, remediation };
}

interface RelationPosture {
	readonly schema: string;
	readonly table: string;
	readonly kind: string;
	readonly owner: string;
	readonly rls: boolean;
	readonly forceRls: boolean;
	readonly selectableColumns: string[];
}

function parseRelations(value: unknown): RelationPosture[] {
	const parsed = typeof value === "string" ? safeJsonParse(value) : value;
	if (!Array.isArray(parsed)) return [];
	return parsed.flatMap((item) => (isRelationPosture(item) ? [item] : []));
}

function safeJsonParse(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return [];
	}
}

function isRelationPosture(value: unknown): value is RelationPosture {
	if (value === null || typeof value !== "object") return false;
	const item = value as Record<string, unknown>;
	return (
		typeof item.schema === "string" &&
		typeof item.table === "string" &&
		typeof item.kind === "string" &&
		typeof item.owner === "string" &&
		typeof item.rls === "boolean" &&
		typeof item.forceRls === "boolean" &&
		Array.isArray(item.selectableColumns) &&
		item.selectableColumns.every((column) => typeof column === "string")
	);
}

function classifiedSensitiveColumns(
	schema: DatabaseSchema | undefined,
	policy: PostgresPrivacyPolicy | undefined,
	schemaName: string,
	tableName: string,
): Set<string> {
	const result = new Set(
		(policy?.sensitiveColumns ?? []).map(
			(reference) =>
				reference.split(".").at(-1)?.toLowerCase() ?? reference.toLowerCase(),
		),
	);
	const table = schema?.tables.find(
		(candidate) =>
			candidate.schema.toLowerCase() === schemaName.toLowerCase() &&
			candidate.name.toLowerCase() === tableName.toLowerCase(),
	);
	for (const column of table?.columns ?? []) {
		if (
			/(?:^|_)(?:address|api_?key|birth|card|credential|dob|email|health|medical|password|phone|secret|ssn|social_security|token)(?:$|_)/i.test(
				column.name,
			)
		) {
			result.add(column.name.toLowerCase());
		}
	}
	return result;
}
