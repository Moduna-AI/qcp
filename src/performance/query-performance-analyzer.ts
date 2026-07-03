import type { DatabaseSchema, SchemaTable } from "@/types/index.js";

export type QueryPerformanceFindingType =
	| "missing_index"
	| "select_star"
	| "plan_summary";

export type QueryPerformanceSeverity = "info" | "warning" | "critical";

export interface QueryPerformanceFinding {
	readonly type: QueryPerformanceFindingType;
	readonly severity: QueryPerformanceSeverity;
	readonly title: string;
	readonly detail: string;
	readonly table?: string;
	readonly columns?: string[];
	readonly suggestionSql?: string;
}

export interface QueryPlanSummary {
	readonly nodeType: string;
	readonly relationName?: string;
	readonly schemaName?: string;
	readonly estimatedRows?: number;
	readonly totalCost?: number;
	readonly startupCost?: number;
}

export interface QueryPerformanceAnalysis {
	readonly summary: string;
	readonly plan: QueryPlanSummary;
	readonly findings: QueryPerformanceFinding[];
	readonly suggestedIndexes: QueryPerformanceFinding[];
	readonly warnings: QueryPerformanceFinding[];
}

interface ExplainRow {
	readonly "QUERY PLAN"?: unknown;
}

interface ExplainDocument {
	readonly Plan?: QueryPlanNode;
}

interface QueryPlanNode {
	readonly "Node Type"?: unknown;
	readonly "Relation Name"?: unknown;
	readonly Schema?: unknown;
	readonly Alias?: unknown;
	readonly Filter?: unknown;
	readonly "Index Cond"?: unknown;
	readonly "Hash Cond"?: unknown;
	readonly "Merge Cond"?: unknown;
	readonly "Join Filter"?: unknown;
	readonly "Plan Rows"?: unknown;
	readonly "Total Cost"?: unknown;
	readonly "Startup Cost"?: unknown;
	readonly Plans?: unknown;
}

interface PredicateCandidate {
	readonly schemaName?: string;
	readonly tableName: string;
	readonly columns: readonly string[];
	readonly nodeType: string;
}

const heavyColumnTypePattern =
	/\b(jsonb?|text|bytea|xml|tsvector|ARRAY|character varying)\b/i;
const sqlKeywordPattern = /^\s*(?:with|select|explain)\b|^\s*\(\s*select\b/i;

export function isLikelySql(input: string): boolean {
	return sqlKeywordPattern.test(input.trim());
}

export class QueryPerformanceAnalyzer {
	private readonly schema: DatabaseSchema;

	public constructor(schema: DatabaseSchema) {
		this.schema = schema;
	}

	public analyze(sql: string, explainPlan: string): QueryPerformanceAnalysis {
		const root = this.parseExplainPlan(explainPlan);
		const planSummary = this.toPlanSummary(root);
		const findings = [
			this.createPlanSummaryFinding(planSummary),
			...this.findMissingIndexSuggestions(root),
			...this.findSelectStarWarnings(sql),
		];

		return {
			summary: this.buildSummary(findings, planSummary),
			plan: planSummary,
			findings,
			suggestedIndexes: findings.filter(
				(finding) => finding.type === "missing_index",
			),
			warnings: findings.filter((finding) => finding.type === "select_star"),
		};
	}

	private parseExplainPlan(explainPlan: string): QueryPlanNode {
		const parsed = JSON.parse(explainPlan) as unknown;
		const plan = extractTopPlan(parsed);
		if (!plan) {
			throw new QueryPerformanceAnalyzerError("Could not read EXPLAIN plan.");
		}
		return plan;
	}

	private toPlanSummary(plan: QueryPlanNode): QueryPlanSummary {
		return {
			nodeType: readString(plan["Node Type"]) ?? "Unknown",
			relationName: readString(plan["Relation Name"]),
			schemaName: readString(plan.Schema),
			estimatedRows: readNumber(plan["Plan Rows"]),
			totalCost: readNumber(plan["Total Cost"]),
			startupCost: readNumber(plan["Startup Cost"]),
		};
	}

	private createPlanSummaryFinding(
		plan: QueryPlanSummary,
	): QueryPerformanceFinding {
		const rowDetail =
			plan.estimatedRows === undefined
				? "unknown estimated rows"
				: `${plan.estimatedRows.toLocaleString()} estimated rows`;
		const costDetail =
			plan.totalCost === undefined
				? "unknown planner cost"
				: `planner cost ${formatCost(plan.totalCost)}`;

		return {
			type: "plan_summary",
			severity: "info",
			title: `${plan.nodeType} plan`,
			detail: `Top plan node is ${plan.nodeType} with ${rowDetail} and ${costDetail}.`,
			table: formatTableId(plan.schemaName, plan.relationName),
		};
	}

	private findMissingIndexSuggestions(
		root: QueryPlanNode,
	): QueryPerformanceFinding[] {
		const candidates = this.collectPredicateCandidates(root);
		const findings: QueryPerformanceFinding[] = [];
		const seen = new Set<string>();

		for (const candidate of candidates) {
			const table = this.findTable(candidate.schemaName, candidate.tableName);
			if (!table) continue;

			const columns = candidate.columns.filter((column) =>
				table.columns.some(
					(schemaColumn) => schemaColumn.name.toLowerCase() === column,
				),
			);
			if (columns.length === 0) continue;
			if (this.hasCoveringIndex(table, columns)) continue;

			const key = `${table.schema}.${table.name}:${columns.join(",")}`;
			if (seen.has(key)) continue;
			seen.add(key);

			const tableId = formatTableId(table.schema, table.name);
			findings.push({
				type: "missing_index",
				severity: columns.length > 1 ? "critical" : "warning",
				title: `No index covers ${columns.join(", ")}`,
				detail: `${candidate.nodeType} filters or joins ${tableId} on ${columns.join(", ")} without a matching leading index. The planner estimates may improve if this predicate is common and selective.`,
				table: tableId,
				columns,
				suggestionSql: buildCreateIndexSql(table, columns),
			});
		}

		return findings;
	}

	private collectPredicateCandidates(
		node: QueryPlanNode,
	): PredicateCandidate[] {
		const candidates: PredicateCandidate[] = [];
		const nodeType = readString(node["Node Type"]) ?? "Plan node";
		const relationName = readString(node["Relation Name"]);
		const schemaName = readString(node.Schema);
		const alias = readString(node.Alias);

		if (relationName && isSequentialScan(nodeType)) {
			const filterColumns = extractColumnsFromCondition(
				readString(node.Filter),
				alias,
			);
			if (filterColumns.length > 0) {
				candidates.push({
					schemaName,
					tableName: relationName,
					columns: filterColumns,
					nodeType,
				});
			}
		}

		for (const condition of [
			readString(node["Hash Cond"]),
			readString(node["Merge Cond"]),
			readString(node["Join Filter"]),
		]) {
			if (!condition) continue;
			candidates.push(...this.extractJoinCandidates(condition, nodeType));
		}

		for (const child of readChildPlans(node)) {
			candidates.push(...this.collectPredicateCandidates(child));
		}

		return candidates;
	}

	private extractJoinCandidates(
		condition: string,
		nodeType: string,
	): PredicateCandidate[] {
		const byQualifier = new Map<string, Set<string>>();
		const pattern = /(?:\b([a-zA-Z_][\w$]*)\.)?([a-zA-Z_][\w$]*)\s*=/g;
		for (const match of condition.matchAll(pattern)) {
			const qualifier = match[1];
			const column = match[2]?.toLowerCase();
			if (!qualifier || !column) continue;
			const columns = byQualifier.get(qualifier) ?? new Set<string>();
			columns.add(column);
			byQualifier.set(qualifier, columns);
		}

		return [...byQualifier.entries()].flatMap(([qualifier, columns]) => {
			const table = this.findTable(undefined, qualifier);
			if (!table) return [];
			return [
				{
					schemaName: table.schema,
					tableName: table.name,
					columns: [...columns],
					nodeType,
				},
			];
		});
	}

	private findSelectStarWarnings(sql: string): QueryPerformanceFinding[] {
		if (!hasSelectStar(sql)) return [];

		return this.extractReferencedTables(sql)
			.map((table) => this.findTable(undefined, table))
			.filter((table): table is SchemaTable => table !== undefined)
			.filter((table) => isWideOrHeavyTable(table))
			.map((table) => {
				const heavyColumns = table.columns
					.filter((column) => heavyColumnTypePattern.test(column.type))
					.map((column) => column.name);
				const heavyDetail =
					heavyColumns.length > 0
						? ` Heavy columns: ${heavyColumns.join(", ")}.`
						: "";

				return {
					type: "select_star",
					severity: "warning",
					title: "SELECT * on wide table",
					detail: `${formatTableId(table.schema, table.name)} has ${table.columns.length} columns.${heavyDetail} Select only needed columns to reduce I/O.`,
					table: formatTableId(table.schema, table.name),
				};
			});
	}

	private extractReferencedTables(sql: string): string[] {
		const matches = sql.matchAll(
			/\b(?:from|join)\s+(?:"?([a-zA-Z_][\w$]*)"?\.)?"?([a-zA-Z_][\w$]*)"?/gi,
		);
		return [...matches]
			.map((match) => match[2])
			.filter((table): table is string => Boolean(table))
			.map((table) => table.toLowerCase());
	}

	private findTable(
		schemaName: string | undefined,
		tableName: string,
	): SchemaTable | undefined {
		const normalizedTable = tableName.toLowerCase();
		const normalizedSchema = schemaName?.toLowerCase();
		return this.schema.tables.find(
			(table) =>
				table.name.toLowerCase() === normalizedTable &&
				(!normalizedSchema || table.schema.toLowerCase() === normalizedSchema),
		);
	}

	private hasCoveringIndex(
		table: SchemaTable,
		columns: readonly string[],
	): boolean {
		const normalizedColumns = columns.map((column) => column.toLowerCase());
		return table.indexes.some((index) => {
			const indexColumns = index.columns.map((column) => column.toLowerCase());
			return normalizedColumns.every(
				(column, indexPosition) => indexColumns[indexPosition] === column,
			);
		});
	}

	private buildSummary(
		findings: readonly QueryPerformanceFinding[],
		plan: QueryPlanSummary,
	): string {
		const indexCount = findings.filter(
			(finding) => finding.type === "missing_index",
		).length;
		const warningCount = findings.filter(
			(finding) => finding.type === "select_star",
		).length;
		const rowDetail =
			plan.estimatedRows === undefined
				? "unknown estimated rows"
				: `${plan.estimatedRows.toLocaleString()} estimated rows`;

		if (indexCount === 0 && warningCount === 0) {
			return `No obvious v1 optimization suggestions. Top plan node is ${plan.nodeType} with ${rowDetail}.`;
		}

		return `Found ${indexCount} index suggestion(s) and ${warningCount} warning(s). Top plan node is ${plan.nodeType} with ${rowDetail}.`;
	}
}

export class QueryPerformanceAnalyzerError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "QueryPerformanceAnalyzerError";
	}
}

function extractTopPlan(parsed: unknown): QueryPlanNode | null {
	if (Array.isArray(parsed)) {
		const first = parsed[0] as ExplainRow | undefined;
		const queryPlan = first?.["QUERY PLAN"];
		if (Array.isArray(queryPlan)) {
			const document = queryPlan[0] as ExplainDocument | undefined;
			return document?.Plan ?? null;
		}
	}

	if (isPlanNode(parsed)) return parsed;
	return null;
}

function readChildPlans(node: QueryPlanNode): QueryPlanNode[] {
	return Array.isArray(node.Plans) ? node.Plans.filter(isPlanNode) : [];
}

function isPlanNode(value: unknown): value is QueryPlanNode {
	return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function isSequentialScan(nodeType: string): boolean {
	return /\bseq scan\b/i.test(nodeType);
}

function extractColumnsFromCondition(
	condition: string | undefined,
	alias: string | undefined,
): string[] {
	if (!condition) return [];

	const columns = new Set<string>();
	const pattern =
		/(?:\b([a-zA-Z_][\w$]*)\.)?([a-zA-Z_][\w$]*)\s*=\s*(?![a-zA-Z_][\w$]*\.)/g;
	for (const match of condition.matchAll(pattern)) {
		const qualifier = match[1];
		const column = match[2];
		if (!column) continue;
		if (qualifier && alias && qualifier.toLowerCase() !== alias.toLowerCase()) {
			continue;
		}
		columns.add(column.toLowerCase());
	}

	return [...columns];
}

function hasSelectStar(sql: string): boolean {
	return /\bselect\s+(?:distinct\s+)?\*/i.test(sql);
}

function isWideOrHeavyTable(table: SchemaTable): boolean {
	return (
		table.columns.length >= 12 ||
		table.columns.some((column) => heavyColumnTypePattern.test(column.type))
	);
}

function buildCreateIndexSql(
	table: SchemaTable,
	columns: readonly string[],
): string {
	const indexName = sanitizeIdentifier(
		`idx_${table.name}_${columns.join("_")}`,
	).slice(0, 63);
	return `CREATE INDEX ${quoteIdentifierIfNeeded(indexName)} ON ${formatSqlTableId(table.schema, table.name)}(${columns.map(quoteIdentifierIfNeeded).join(", ")});`;
}

function sanitizeIdentifier(value: string): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return /^[a-z_]/.test(sanitized) ? sanitized : `idx_${sanitized}`;
}

function quoteIdentifierIfNeeded(identifier: string): string {
	if (/^[a-z_][a-z0-9_]*$/.test(identifier)) return identifier;
	return `"${identifier.replace(/"/g, '""')}"`;
}

function formatSqlTableId(schemaName: string, tableName: string): string {
	if (schemaName === "public") return quoteIdentifierIfNeeded(tableName);
	return `${quoteIdentifierIfNeeded(schemaName)}.${quoteIdentifierIfNeeded(tableName)}`;
}

function formatTableId(
	schemaName: string | undefined,
	tableName: string | undefined,
): string | undefined {
	if (!tableName) return undefined;
	if (!schemaName || schemaName === "public") return tableName;
	return `${schemaName}.${tableName}`;
}

function formatCost(cost: number): string {
	return Number.isInteger(cost) ? cost.toLocaleString() : cost.toFixed(2);
}
