import { existsSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import postgres, { type TransactionSql } from "postgres";
import { createLocalSqliteClient } from "@/sqlite-client.js";

const SQLITE_EXTENSIONS = new Set([".db", ".sqlite", ".sqlite3"]);
const INSERT_BATCH_SIZE = 500;
const MAX_DIAGNOSTIC_LENGTH = 2_000;

export type SqliteImportErrorCategory =
	| "invalid_source"
	| "outside_workspace"
	| "unsupported_source"
	| "empty_database"
	| "identifier_collision"
	| "destination_conflict"
	| "migration_failed";

export interface SqliteImportTableSummary {
	readonly sourceTable: string;
	readonly targetTable: string;
	readonly rowCount: number;
}

export type SqliteDatabaseImportResult =
	| {
			readonly ok: true;
			readonly sourcePath: string;
			readonly targetSchema: "public";
			readonly tableCount: number;
			readonly totalRowCount: number;
			readonly tables: readonly SqliteImportTableSummary[];
			readonly durationMs: number;
			readonly schemaRefreshed: boolean;
	  }
	| {
			readonly ok: false;
			readonly category: SqliteImportErrorCategory;
			readonly sourcePath?: string;
			readonly error: string;
			readonly rolledBack: boolean;
	  };

export interface SqliteColumnPlan {
	readonly sourceName: string;
	readonly targetName: string;
	readonly sqliteType: string;
	readonly postgresType: string;
	readonly nullable: boolean;
	readonly primaryKeyPosition: number;
	readonly identity: boolean;
}

export interface SqliteForeignKeyPlan {
	readonly sourceTable: string;
	readonly sourceColumns: readonly string[];
	readonly targetTable: string;
	readonly targetColumns: readonly string[];
	readonly onUpdate: string;
	readonly onDelete: string;
}

export interface SqliteIndexPlan {
	readonly sourceName: string;
	readonly targetName: string;
	readonly columns: readonly string[];
	readonly unique: boolean;
}

export interface SqliteTablePlan {
	readonly sourceName: string;
	readonly targetName: string;
	readonly columns: readonly SqliteColumnPlan[];
	readonly primaryKey: readonly string[];
	readonly foreignKeys: readonly SqliteForeignKeyPlan[];
	readonly indexes: readonly SqliteIndexPlan[];
	readonly rows: readonly Record<string, unknown>[];
}

export interface SqliteMigrationPlan {
	readonly sourcePath: string;
	readonly targetSchema: "public";
	readonly tables: readonly SqliteTablePlan[];
}

export interface SqliteMigrationExecutor {
	execute(
		plan: SqliteMigrationPlan,
	): Promise<readonly SqliteImportTableSummary[]>;
}

export interface SqliteDatabaseImporterOptions {
	readonly databaseUrl: string;
	readonly cwd?: string;
	readonly executor?: SqliteMigrationExecutor;
	readonly refreshSchema?: () => Promise<void>;
}

export class SqliteDatabaseImporter {
	private readonly cwd: string;
	private readonly executor: SqliteMigrationExecutor;
	private readonly refreshSchema?: () => Promise<void>;

	public constructor(options: SqliteDatabaseImporterOptions) {
		this.cwd = options.cwd ?? process.cwd();
		this.executor =
			options.executor ??
			new PostgresSqliteMigrationExecutor(options.databaseUrl);
		this.refreshSchema = options.refreshSchema;
	}

	public async importDatabase(
		filePath: string,
	): Promise<SqliteDatabaseImportResult> {
		const start = Date.now();
		let sourcePath: string | undefined;
		try {
			sourcePath = resolveSqliteSourcePath(this.cwd, filePath);
			const plan = await buildSqliteMigrationPlan(sourcePath);
			const tables = await this.executor.execute(plan);
			if (this.refreshSchema) await this.refreshSchema();
			return {
				ok: true,
				sourcePath,
				targetSchema: "public",
				tableCount: tables.length,
				totalRowCount: tables.reduce(
					(total, table) => total + table.rowCount,
					0,
				),
				tables,
				durationMs: Date.now() - start,
				schemaRefreshed: Boolean(this.refreshSchema),
			};
		} catch (err: unknown) {
			const failure = toImportFailure(err);
			return {
				ok: false,
				category: failure.category,
				sourcePath,
				error: truncateDiagnostic(failure.message),
				rolledBack: failure.rolledBack,
			};
		}
	}
}

class SqliteImportError extends Error {
	public constructor(
		public readonly category: SqliteImportErrorCategory,
		message: string,
		public readonly rolledBack = false,
	) {
		super(message);
		this.name = "SqliteImportError";
	}
}

class PostgresSqliteMigrationExecutor implements SqliteMigrationExecutor {
	public constructor(private readonly databaseUrl: string) {}

	public async execute(
		plan: SqliteMigrationPlan,
	): Promise<readonly SqliteImportTableSummary[]> {
		const db = postgres(this.databaseUrl, {
			max: 1,
			connect_timeout: 15,
			idle_timeout: 5,
			connection: { application_name: "qcp-sqlite-import" },
		});

		try {
			return await db.begin(async (transaction) => {
				const sql = transaction as TransactionSql<Record<string, unknown>>;
				await assertDestinationIsEmpty(sql, plan);
				for (const table of plan.tables) await createTable(sql, plan, table);
				for (const table of plan.tables)
					await insertTableRows(sql, plan, table);
				for (const table of plan.tables) {
					await createForeignKeys(sql, plan, table);
					await createIndexes(sql, plan, table);
					await alignIdentitySequences(sql, plan, table);
				}
				return plan.tables.map((table) => ({
					sourceTable: table.sourceName,
					targetTable: table.targetName,
					rowCount: table.rows.length,
				}));
			});
		} catch (err: unknown) {
			if (err instanceof SqliteImportError) throw err;
			throw new SqliteImportError(
				"migration_failed",
				formatUnknownError(err),
				true,
			);
		} finally {
			await db.end({ timeout: 2 }).catch(() => {});
		}
	}
}

export function resolveSqliteSourcePath(cwd: string, filePath: string): string {
	const workspace = realpathSync(resolve(cwd));
	const candidate = resolve(workspace, filePath);
	const candidateRelative = relative(workspace, candidate);
	if (isOutsideWorkspace(candidateRelative)) {
		throw new SqliteImportError(
			"outside_workspace",
			`Refusing to import outside the current working directory: ${filePath}`,
		);
	}
	if (!existsSync(candidate) || !statSync(candidate).isFile()) {
		throw new SqliteImportError(
			"invalid_source",
			`File not found: ${filePath}`,
		);
	}
	const sourcePath = realpathSync(candidate);
	if (isOutsideWorkspace(relative(workspace, sourcePath))) {
		throw new SqliteImportError(
			"outside_workspace",
			`Refusing to follow an import path outside the current working directory: ${filePath}`,
		);
	}
	if (!SQLITE_EXTENSIONS.has(extname(sourcePath).toLowerCase())) {
		throw new SqliteImportError(
			"unsupported_source",
			"Full database import requires a .db, .sqlite, or .sqlite3 file.",
		);
	}
	return sourcePath;
}

export async function buildSqliteMigrationPlan(
	sourcePath: string,
): Promise<SqliteMigrationPlan> {
	const client = await createLocalSqliteClient(sourcePath);
	try {
		const tableRows = await client.execute(
			"SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
		);
		const sourceNames = tableRows.rows
			.map((row) => readString(row, "name"))
			.filter((name): name is string => Boolean(name));
		if (sourceNames.length === 0) {
			throw new SqliteImportError(
				"empty_database",
				"SQLite database does not contain any user tables.",
			);
		}

		const tableNameMap = createIdentifierMap(sourceNames, "table");
		const tables: SqliteTablePlan[] = [];
		for (const sourceName of sourceNames) {
			tables.push(await inspectTable(client, sourceName, tableNameMap));
		}
		return { sourcePath, targetSchema: "public", tables };
	} finally {
		await client.close();
	}
}

async function inspectTable(
	client: Awaited<ReturnType<typeof createLocalSqliteClient>>,
	sourceName: string,
	tableNameMap: ReadonlyMap<string, string>,
): Promise<SqliteTablePlan> {
	const columnResult = await client.execute(
		`PRAGMA table_info(${quoteSqliteIdentifier(sourceName)})`,
	);
	const sourceColumnNames = columnResult.rows.map((row) =>
		requireString(row, "name", `column in ${sourceName}`),
	);
	const columnNameMap = createIdentifierMap(
		sourceColumnNames,
		`column in ${sourceName}`,
	);
	const primaryKeySize = columnResult.rows.filter(
		(row) => readNumber(row, "pk") > 0,
	).length;
	const columns = columnResult.rows.map((row): SqliteColumnPlan => {
		const sourceColumn = requireString(row, "name", `column in ${sourceName}`);
		const sqliteType = readString(row, "type") ?? "";
		const primaryKeyPosition = readNumber(row, "pk");
		return {
			sourceName: sourceColumn,
			targetName: requireMappedIdentifier(columnNameMap, sourceColumn),
			sqliteType,
			postgresType: mapSqliteTypeToPostgres(sqliteType),
			nullable: readNumber(row, "notnull") === 0 && primaryKeyPosition === 0,
			primaryKeyPosition,
			identity:
				primaryKeySize === 1 &&
				primaryKeyPosition === 1 &&
				/^\s*integer\s*$/i.test(sqliteType),
		};
	});
	const primaryKey = columns
		.filter((column) => column.primaryKeyPosition > 0)
		.sort((left, right) => left.primaryKeyPosition - right.primaryKeyPosition)
		.map((column) => column.targetName);

	const foreignKeys = await inspectForeignKeys(
		client,
		sourceName,
		tableNameMap,
		columnNameMap,
	);
	const indexes = await inspectIndexes(client, sourceName, columnNameMap);
	const rowResult = await client.execute(
		`SELECT * FROM ${quoteSqliteIdentifier(sourceName)}`,
	);
	const rows = rowResult.rows.map((row) =>
		Object.fromEntries(
			columns.map((column) => [column.targetName, row[column.sourceName]]),
		),
	);

	return {
		sourceName,
		targetName: requireMappedIdentifier(tableNameMap, sourceName),
		columns,
		primaryKey,
		foreignKeys,
		indexes,
		rows,
	};
}

async function inspectForeignKeys(
	client: Awaited<ReturnType<typeof createLocalSqliteClient>>,
	sourceName: string,
	tableNameMap: ReadonlyMap<string, string>,
	columnNameMap: ReadonlyMap<string, string>,
): Promise<readonly SqliteForeignKeyPlan[]> {
	const result = await client.execute(
		`PRAGMA foreign_key_list(${quoteSqliteIdentifier(sourceName)})`,
	);
	const grouped = new Map<number, Record<string, unknown>[]>();
	for (const row of result.rows) {
		const id = readNumber(row, "id");
		grouped.set(id, [...(grouped.get(id) ?? []), row]);
	}
	return [...grouped.values()].map((rows) => {
		const ordered = [...rows].sort(
			(left, right) => readNumber(left, "seq") - readNumber(right, "seq"),
		);
		const targetSourceTable = requireString(
			ordered[0] ?? {},
			"table",
			`foreign key target from ${sourceName}`,
		);
		const targetTable = requireMappedIdentifier(
			tableNameMap,
			targetSourceTable,
		);
		return {
			sourceTable: sourceName,
			sourceColumns: ordered.map((row) =>
				requireMappedIdentifier(
					columnNameMap,
					requireString(row, "from", `foreign key column in ${sourceName}`),
				),
			),
			targetTable,
			targetColumns: ordered.map((row) =>
				toSnakeCase(
					requireString(row, "to", `foreign key target in ${sourceName}`),
				),
			),
			onUpdate: normalizeReferenceAction(
				readString(ordered[0] ?? {}, "on_update"),
			),
			onDelete: normalizeReferenceAction(
				readString(ordered[0] ?? {}, "on_delete"),
			),
		};
	});
}

async function inspectIndexes(
	client: Awaited<ReturnType<typeof createLocalSqliteClient>>,
	sourceName: string,
	columnNameMap: ReadonlyMap<string, string>,
): Promise<readonly SqliteIndexPlan[]> {
	const result = await client.execute(
		`PRAGMA index_list(${quoteSqliteIdentifier(sourceName)})`,
	);
	const indexes: SqliteIndexPlan[] = [];
	for (const row of result.rows) {
		if (readString(row, "origin") === "pk") continue;
		if (readNumber(row, "partial") !== 0) continue;
		const sourceIndexName = requireString(
			row,
			"name",
			`index on ${sourceName}`,
		);
		const indexResult = await client.execute(
			`PRAGMA index_info(${quoteSqliteIdentifier(sourceIndexName)})`,
		);
		const columns = [...indexResult.rows]
			.sort(
				(left, right) => readNumber(left, "seqno") - readNumber(right, "seqno"),
			)
			.map((indexRow) =>
				requireMappedIdentifier(
					columnNameMap,
					requireString(indexRow, "name", `index column in ${sourceIndexName}`),
				),
			);
		if (columns.length === 0) continue;
		indexes.push({
			sourceName: sourceIndexName,
			targetName: boundedIdentifier(
				`idx_${toSnakeCase(sourceName)}_${toSnakeCase(sourceIndexName)}`,
			),
			columns,
			unique: readNumber(row, "unique") === 1,
		});
	}
	return indexes;
}

export function toSnakeCase(value: string): string {
	const normalized = value
		.trim()
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
		.replace(/[^a-zA-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toLowerCase();
	if (!normalized) {
		throw new SqliteImportError(
			"identifier_collision",
			`Identifier cannot be normalized safely: ${value}`,
		);
	}
	return /^[a-z_]/.test(normalized) ? normalized : `t_${normalized}`;
}

export function mapSqliteTypeToPostgres(sqliteType: string): string {
	const declared = sqliteType.trim().toUpperCase();
	const varchar = /^(?:N?VAR)?CHAR(?:ACTER)?\s*\((\d+)\)/.exec(declared);
	if (varchar?.[1]) return `varchar(${varchar[1]})`;
	const numeric = /^(?:NUMERIC|DECIMAL)\s*\((\d+)\s*,\s*(\d+)\)/.exec(declared);
	if (numeric?.[1] && numeric[2]) return `numeric(${numeric[1]},${numeric[2]})`;
	if (/\bINT\b|INT(?:EGER)?/.test(declared)) return "integer";
	if (/DATETIME|TIMESTAMP/.test(declared)) return "timestamp";
	if (/\bDATE\b/.test(declared)) return "date";
	if (/\bBOOL(?:EAN)?\b/.test(declared)) return "boolean";
	if (/REAL|FLOA|DOUB/.test(declared)) return "double precision";
	if (/NUMERIC|DECIMAL/.test(declared)) return "numeric";
	if (/BLOB|BINARY/.test(declared)) return "bytea";
	return "text";
}

async function assertDestinationIsEmpty(
	sql: TransactionSql<Record<string, unknown>>,
	plan: SqliteMigrationPlan,
): Promise<void> {
	const literals = plan.tables
		.map((table) => quotePostgresLiteral(table.targetName))
		.join(", ");
	const rows = await sql.unsafe(
		`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN (${literals}) ORDER BY table_name`,
	);
	if (rows.length === 0) return;
	const conflicts = rows.map((row) => String(row.table_name)).join(", ");
	throw new SqliteImportError(
		"destination_conflict",
		`Destination tables already exist in public: ${conflicts}`,
		true,
	);
}

async function createTable(
	sql: TransactionSql<Record<string, unknown>>,
	plan: SqliteMigrationPlan,
	table: SqliteTablePlan,
): Promise<void> {
	const definitions = table.columns.map((column) => {
		const identity = column.identity ? " GENERATED BY DEFAULT AS IDENTITY" : "";
		const nullable = column.nullable ? "" : " NOT NULL";
		return `${quotePostgresIdentifier(column.targetName)} ${column.postgresType}${identity}${nullable}`;
	});
	if (table.primaryKey.length > 0) {
		definitions.push(
			`CONSTRAINT ${quotePostgresIdentifier(boundedIdentifier(`pk_${table.targetName}`))} PRIMARY KEY (${table.primaryKey.map(quotePostgresIdentifier).join(", ")})`,
		);
	}
	await sql.unsafe(
		`CREATE TABLE ${qualifiedTable(plan.targetSchema, table.targetName)} (${definitions.join(", ")})`,
	);
}

async function insertTableRows(
	sql: TransactionSql<Record<string, unknown>>,
	plan: SqliteMigrationPlan,
	table: SqliteTablePlan,
): Promise<void> {
	if (table.rows.length === 0) return;
	const columns = table.columns.map((column) => column.targetName);
	for (
		let offset = 0;
		offset < table.rows.length;
		offset += INSERT_BATCH_SIZE
	) {
		const batch = table.rows.slice(offset, offset + INSERT_BATCH_SIZE);
		const values: unknown[] = [];
		const tuples = batch.map((row) => {
			const placeholders = columns.map((column) => {
				values.push(row[column]);
				return `$${values.length}`;
			});
			return `(${placeholders.join(", ")})`;
		});
		await sql.unsafe(
			`INSERT INTO ${qualifiedTable(plan.targetSchema, table.targetName)} (${columns.map(quotePostgresIdentifier).join(", ")}) VALUES ${tuples.join(", ")}`,
			values,
		);
	}
}

async function createForeignKeys(
	sql: TransactionSql<Record<string, unknown>>,
	plan: SqliteMigrationPlan,
	table: SqliteTablePlan,
): Promise<void> {
	for (const [index, foreignKey] of table.foreignKeys.entries()) {
		const constraintName = boundedIdentifier(
			`fk_${table.targetName}_${foreignKey.sourceColumns.join("_")}_${index + 1}`,
		);
		await sql.unsafe(
			`ALTER TABLE ${qualifiedTable(plan.targetSchema, table.targetName)} ADD CONSTRAINT ${quotePostgresIdentifier(constraintName)} FOREIGN KEY (${foreignKey.sourceColumns.map(quotePostgresIdentifier).join(", ")}) REFERENCES ${qualifiedTable(plan.targetSchema, foreignKey.targetTable)} (${foreignKey.targetColumns.map(quotePostgresIdentifier).join(", ")}) ON UPDATE ${foreignKey.onUpdate} ON DELETE ${foreignKey.onDelete}`,
		);
	}
}

async function createIndexes(
	sql: TransactionSql<Record<string, unknown>>,
	plan: SqliteMigrationPlan,
	table: SqliteTablePlan,
): Promise<void> {
	for (const index of table.indexes) {
		await sql.unsafe(
			`CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quotePostgresIdentifier(index.targetName)} ON ${qualifiedTable(plan.targetSchema, table.targetName)} (${index.columns.map(quotePostgresIdentifier).join(", ")})`,
		);
	}
}

async function alignIdentitySequences(
	sql: TransactionSql<Record<string, unknown>>,
	plan: SqliteMigrationPlan,
	table: SqliteTablePlan,
): Promise<void> {
	for (const column of table.columns.filter(
		(candidate) => candidate.identity,
	)) {
		const tableReference = `${plan.targetSchema}.${table.targetName}`;
		const sequenceRows = await sql.unsafe(
			"SELECT pg_get_serial_sequence($1, $2) AS sequence_name",
			[tableReference, column.targetName],
		);
		const sequenceName = sequenceRows[0]?.sequence_name;
		if (typeof sequenceName !== "string" || !sequenceName) continue;
		await sql.unsafe(
			`SELECT setval($1, COALESCE((SELECT MAX(${quotePostgresIdentifier(column.targetName)}) FROM ${qualifiedTable(plan.targetSchema, table.targetName)}), 1), EXISTS(SELECT 1 FROM ${qualifiedTable(plan.targetSchema, table.targetName)}))`,
			[sequenceName],
		);
	}
}

function createIdentifierMap(
	sourceNames: readonly string[],
	context: string,
): ReadonlyMap<string, string> {
	const mapping = new Map<string, string>();
	const used = new Map<string, string>();
	for (const sourceName of sourceNames) {
		const targetName = toSnakeCase(sourceName);
		const previous = used.get(targetName);
		if (previous && previous !== sourceName) {
			throw new SqliteImportError(
				"identifier_collision",
				`Cannot import ${context} names ${previous} and ${sourceName}; both normalize to ${targetName}.`,
			);
		}
		used.set(targetName, sourceName);
		mapping.set(sourceName, targetName);
	}
	return mapping;
}

function requireMappedIdentifier(
	mapping: ReadonlyMap<string, string>,
	sourceName: string,
): string {
	const target = mapping.get(sourceName);
	if (!target) {
		throw new SqliteImportError(
			"migration_failed",
			`SQLite metadata references an unknown identifier: ${sourceName}`,
		);
	}
	return target;
}

function normalizeReferenceAction(value: string | undefined): string {
	const normalized = (value ?? "NO ACTION").toUpperCase();
	return [
		"NO ACTION",
		"RESTRICT",
		"CASCADE",
		"SET NULL",
		"SET DEFAULT",
	].includes(normalized)
		? normalized
		: "NO ACTION";
}

function boundedIdentifier(identifier: string): string {
	if (identifier.length <= 63) return identifier;
	let hash = 2166136261;
	for (const character of identifier) {
		hash ^= character.charCodeAt(0);
		hash = Math.imul(hash, 16777619);
	}
	return `${identifier.slice(0, 54)}_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function isOutsideWorkspace(relativePath: string): boolean {
	return (
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	);
}

function quoteSqliteIdentifier(identifier: string): string {
	return `"${identifier.replace(/"/g, '""')}"`;
}

function quotePostgresIdentifier(identifier: string): string {
	return `"${identifier.replace(/"/g, '""')}"`;
}

function quotePostgresLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function qualifiedTable(schema: string, table: string): string {
	return `${quotePostgresIdentifier(schema)}.${quotePostgresIdentifier(table)}`;
}

function readString(
	row: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = row[key];
	return typeof value === "string" ? value : undefined;
}

function requireString(
	row: Record<string, unknown>,
	key: string,
	context: string,
): string {
	const value = readString(row, key);
	if (value) return value;
	throw new SqliteImportError(
		"migration_failed",
		`SQLite metadata is missing ${key} for ${context}.`,
	);
}

function readNumber(row: Record<string, unknown>, key: string): number {
	const value = row[key];
	return typeof value === "number" ? value : Number(value ?? 0);
}

function toImportFailure(err: unknown): {
	readonly category: SqliteImportErrorCategory;
	readonly message: string;
	readonly rolledBack: boolean;
} {
	if (err instanceof SqliteImportError) {
		return {
			category: err.category,
			message: err.message,
			rolledBack: err.rolledBack,
		};
	}
	return {
		category: "migration_failed",
		message: formatUnknownError(err),
		rolledBack: true,
	};
}

function formatUnknownError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function truncateDiagnostic(message: string): string {
	return message.length <= MAX_DIAGNOSTIC_LENGTH
		? message
		: `${message.slice(0, MAX_DIAGNOSTIC_LENGTH)}…`;
}
