import { executeQuery } from "@/db/index.js";
import type { QueryResult } from "@/types/index.js";
import { semanticObjectId } from "./indexer.js";
import type { SemanticStore } from "./store.js";
import type { SemanticObject, SemanticValueFrequency } from "./types.js";

export interface SemanticValueProfilerOptions {
	readonly store: SemanticStore;
	readonly databaseUrl: string;
	readonly sensitivePatterns: readonly string[];
	readonly queryExecutor?: (
		databaseUrl: string,
		sql: string,
		timeoutMs?: number,
	) => Promise<QueryResult>;
}

export interface ProfileSemanticValuesOptions {
	readonly connectionId: string;
	readonly schemaName: string;
	readonly tableName: string;
	readonly columnNames?: readonly string[];
	readonly includeSensitive?: boolean;
	readonly limit?: number;
}

export interface SemanticProfileResult {
	readonly profiledColumns: readonly string[];
	readonly skippedColumns: readonly {
		readonly columnName: string;
		readonly reason: string;
	}[];
}

const UNSUPPORTED_PROFILE_TYPES = new Set([
	"bytea",
	"json",
	"jsonb",
	"xml",
	"tsvector",
]);

export class SemanticValueProfiler {
	private readonly store: SemanticStore;
	private readonly databaseUrl: string;
	private readonly sensitivePatterns: readonly string[];
	private readonly queryExecutor: (
		databaseUrl: string,
		sql: string,
		timeoutMs?: number,
	) => Promise<QueryResult>;

	public constructor(options: SemanticValueProfilerOptions) {
		this.store = options.store;
		this.databaseUrl = options.databaseUrl;
		this.sensitivePatterns = options.sensitivePatterns;
		this.queryExecutor = options.queryExecutor ?? executeQuery;
	}

	public async profile(
		options: ProfileSemanticValuesOptions,
	): Promise<SemanticProfileResult> {
		const allColumns = await this.store.listObjects({
			connectionId: options.connectionId,
			activeOnly: true,
			objectType: "column",
		});
		const selected = allColumns.filter(
			(object) =>
				object.schemaName === options.schemaName &&
				object.tableName === options.tableName &&
				(options.columnNames === undefined ||
					options.columnNames.includes(object.columnName ?? "")),
		);
		const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
		const profiledColumns: string[] = [];
		const skippedColumns: { columnName: string; reason: string }[] = [];

		for (const column of selected) {
			const columnName = column.columnName;
			if (!columnName) continue;

			if (
				!options.includeSensitive &&
				isSensitiveColumn(column, this.sensitivePatterns)
			) {
				skippedColumns.push({
					columnName,
					reason: "matches sensitive table or column pattern",
				});
				continue;
			}

			if (
				UNSUPPORTED_PROFILE_TYPES.has((column.dataType ?? "").toLowerCase())
			) {
				skippedColumns.push({
					columnName,
					reason: "unsupported value profiling type",
				});
				continue;
			}

			const profile = await profileColumn({
				databaseUrl: this.databaseUrl,
				queryExecutor: this.queryExecutor,
				schemaName: options.schemaName,
				tableName: options.tableName,
				columnName,
				limit,
			});

			await this.store.upsertValueProfile({
				objectId: column.id,
				distinctCount: profile.distinctCount,
				sampleValues: profile.sampleValues,
				topValues: profile.topValues,
				truncated: profile.truncated,
			});
			profiledColumns.push(columnName);
		}

		return {
			profiledColumns,
			skippedColumns,
		};
	}
}

export function resolveProfileColumnObjectId(input: {
	readonly connectionId: string;
	readonly schemaName: string;
	readonly tableName: string;
	readonly columnName: string;
}): string {
	return semanticObjectId({
		connectionId: input.connectionId,
		objectType: "column",
		schemaName: input.schemaName,
		tableName: input.tableName,
		columnName: input.columnName,
	});
}

async function profileColumn(options: {
	readonly databaseUrl: string;
	readonly queryExecutor: (
		databaseUrl: string,
		sql: string,
		timeoutMs?: number,
	) => Promise<QueryResult>;
	readonly schemaName: string;
	readonly tableName: string;
	readonly columnName: string;
	readonly limit: number;
}): Promise<{
	readonly distinctCount?: number;
	readonly sampleValues: readonly string[];
	readonly topValues: readonly SemanticValueFrequency[];
	readonly truncated: boolean;
}> {
	const table = `${quoteIdentifier(options.schemaName)}.${quoteIdentifier(
		options.tableName,
	)}`;
	const column = quoteIdentifier(options.columnName);
	const distinctSql = `
    SELECT COUNT(DISTINCT ${column})::bigint AS distinct_count
    FROM ${table}
    WHERE ${column} IS NOT NULL
  `;
	const topSql = `
    SELECT ${column}::text AS value, COUNT(*)::bigint AS frequency
    FROM ${table}
    WHERE ${column} IS NOT NULL
    GROUP BY ${column}
    ORDER BY COUNT(*) DESC, ${column}::text ASC
    LIMIT ${options.limit}
  `;
	const sampleSql = `
    SELECT ${column}::text AS value
    FROM ${table}
    WHERE ${column} IS NOT NULL
    ORDER BY ${column}::text ASC
    LIMIT ${options.limit}
  `;

	const [distinctResult, topResult, sampleResult] = await Promise.all([
		options.queryExecutor(options.databaseUrl, distinctSql, 5_000),
		options.queryExecutor(options.databaseUrl, topSql, 5_000),
		options.queryExecutor(options.databaseUrl, sampleSql, 5_000),
	]);

	const distinctCount = parseOptionalNumber(
		distinctResult.rows[0]?.distinct_count,
	);
	const topValues = topResult.rows.map((row) => ({
		value: truncateValue(row.value),
		frequency: parseOptionalNumber(row.frequency) ?? 0,
	}));
	const sampleValues = sampleResult.rows.map((row) => truncateValue(row.value));
	const truncated =
		topResult.rows.some((row) => String(row.value ?? "").length > 80) ||
		sampleResult.rows.some((row) => String(row.value ?? "").length > 80);

	return {
		distinctCount,
		sampleValues,
		topValues,
		truncated,
	};
}

function isSensitiveColumn(
	column: SemanticObject,
	patterns: readonly string[],
): boolean {
	const subject = [column.schemaName, column.tableName, column.columnName ?? ""]
		.join(".")
		.toLowerCase();
	return patterns.some((pattern) => {
		const normalized = pattern.toLowerCase().trim();
		return normalized.length > 0 && subject.includes(normalized);
	});
}

function quoteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function parseOptionalNumber(value: unknown): number | undefined {
	if (typeof value === "number") return value;
	if (typeof value === "bigint") return Number(value);
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function truncateValue(value: unknown): string {
	const text = String(value ?? "");
	return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}
