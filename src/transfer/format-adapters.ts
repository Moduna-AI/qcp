import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
	importPackageFromStore,
	requirePackageGroup,
	type PackageGroup,
} from "@/packages/lazy-packages.js";
import type {
	DatabaseTransferDirection,
	DatabaseTransferFormat,
	FormatDetectionResult,
	TransferFormatAdapter,
	TransferImportRows,
} from "./types.js";

const ADAPTERS: readonly TransferFormatAdapter[] = [
	{
		format: "csv",
		label: "CSV",
		extensions: [".csv"],
		importSupported: true,
		exportSupported: true,
		exportRows: (rows, filePath) => writeDelimitedRows(rows, filePath, ","),
		importRows: async (filePath) => readDelimitedRows(filePath, ","),
	},
	{
		format: "tsv",
		label: "TSV",
		extensions: [".tsv", ".tab"],
		importSupported: true,
		exportSupported: true,
		exportRows: (rows, filePath) => writeDelimitedRows(rows, filePath, "\t"),
		importRows: async (filePath) => readDelimitedRows(filePath, "\t"),
	},
	{
		format: "json",
		label: "JSON",
		extensions: [".json"],
		importSupported: true,
		exportSupported: true,
		exportRows: (rows, filePath) => writeJsonRows(rows, filePath),
		importRows: async (filePath) => readJsonRows(filePath),
	},
	{
		format: "jsonl",
		label: "JSONL",
		extensions: [".jsonl", ".ndjson"],
		importSupported: true,
		exportSupported: true,
		exportRows: (rows, filePath) => writeJsonlRows(rows, filePath),
		importRows: async (filePath) => readJsonlRows(filePath),
	},
	{
		format: "parquet",
		label: "Parquet",
		extensions: [".parquet"],
		packageGroup: "format-parquet",
		importSupported: true,
		exportSupported: true,
		exportRows: async (rows, filePath) => writeParquetRows(rows, filePath),
		importRows: async (filePath) => readParquetRows(filePath),
	},
	{
		format: "sqlite",
		label: "SQLite .db",
		extensions: [".db", ".sqlite", ".sqlite3"],
		packageGroup: "format-sqlite",
		importSupported: true,
		exportSupported: true,
		exportRows: async (rows, filePath) => writeSqliteRows(rows, filePath),
		importRows: async (filePath) => readSqliteRows(filePath),
	},
	{
		format: "pandas",
		label: "Pandas pickle",
		extensions: [".pd", ".pkl", ".pickle"],
		packageGroup: "format-pandas",
		importSupported: false,
		exportSupported: true,
		exportRows: async (rows, filePath) => writePandasPickleRows(rows, filePath),
	},
	{
		format: "postgres-dump",
		label: "PostgreSQL dump",
		extensions: [".sql", ".dump", ".tar"],
		importSupported: true,
		exportSupported: true,
		exportRows: (rows, filePath) => writeSqlDumpRows(rows, filePath),
		importRows: async (filePath) => readSqlDumpRows(filePath),
	},
];

interface ParquetSchemaConstructor {
	new (schema: Record<string, { readonly type: "UTF8"; readonly optional: true }>): unknown;
}

interface ParquetWriterLike {
	appendRow(row: Record<string, unknown>): Promise<void>;
	close(): Promise<void>;
}

interface ParquetReaderLike {
	getCursor(): {
		next(): Promise<Record<string, unknown> | null>;
	};
	close(): Promise<void>;
}

interface ParquetModule {
	readonly ParquetSchema: ParquetSchemaConstructor;
	readonly ParquetWriter: {
		openFile(schema: unknown, filePath: string): Promise<ParquetWriterLike>;
	};
	readonly ParquetReader: {
		openFile(filePath: string): Promise<ParquetReaderLike>;
	};
}

interface LibsqlResult {
	readonly rows: readonly Record<string, unknown>[];
}

interface LibsqlClient {
	execute(
		statement:
			| string
			| { readonly sql: string; readonly args: readonly unknown[] },
	): Promise<LibsqlResult>;
	close(): void;
}

interface LibsqlModule {
	createClient(options: { readonly url: string }): LibsqlClient;
}

interface PyodideFilesystem {
	readFile(
		path: string,
		options: { readonly encoding: "binary" },
	): Uint8Array;
}

interface PyodideRuntime {
	readonly FS: PyodideFilesystem;
	loadPackage(packageName: string): Promise<void>;
	runPythonAsync(code: string): Promise<unknown>;
}

interface PyodideModule {
	loadPyodide(options?: Record<string, unknown>): Promise<PyodideRuntime>;
}

export function listTransferFormatAdapters(): readonly TransferFormatAdapter[] {
	return ADAPTERS;
}

export function listSupportedTransferFormats(
	direction?: DatabaseTransferDirection,
): readonly DatabaseTransferFormat[] {
	return ADAPTERS.filter((adapter) => {
		if (direction === "import") return adapter.importSupported;
		if (direction === "export") return adapter.exportSupported;
		return true;
	}).map((adapter) => adapter.format);
}

export function getTransferFormatAdapter(
	format: DatabaseTransferFormat,
): TransferFormatAdapter {
	const adapter = ADAPTERS.find((candidate) => candidate.format === format);
	if (!adapter) {
		throw new Error(`Unsupported transfer format: ${format}`);
	}
	return adapter;
}

export function detectTransferFormat(
	filePath: string,
	explicitFormat?: DatabaseTransferFormat,
): FormatDetectionResult | null {
	if (explicitFormat) {
		const adapter = getTransferFormatAdapter(explicitFormat);
		return {
			format: explicitFormat,
			extension: adapter.extensions[0] ?? "",
		};
	}

	const lowerPath = filePath.toLowerCase();
	const adapter = ADAPTERS.find((candidate) =>
		candidate.extensions.some((extension) => lowerPath.endsWith(extension)),
	);
	if (!adapter) return null;

	const extension =
		adapter.extensions.find((candidate) => lowerPath.endsWith(candidate)) ??
		adapter.extensions[0] ??
		"";
	return {
		format: adapter.format,
		extension,
	};
}

export function assertAdapterAvailable(
	adapter: TransferFormatAdapter,
	direction: DatabaseTransferDirection,
): string | null {
	const supported =
		direction === "import" ? adapter.importSupported : adapter.exportSupported;
	if (!supported) {
		if (adapter.format === "pandas") {
			return `${adapter.label} ${direction} is refused because Python pickle files can execute code when loaded. Use CSV, JSON, JSONL, TSV, Parquet, or SQLite instead.`;
		}
		const suffix = adapter.packageGroup
			? ` Install ${formatInstallHint(adapter.packageGroup)} when adapter support is available.`
			: "";
		return `${adapter.label} ${direction} is not supported by qcp yet.${suffix}`;
	}

	if (adapter.packageGroup) {
		try {
			requirePackageGroup(adapter.packageGroup);
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			return `${adapter.label} ${direction} requires optional runtime packages.\n${message}`;
		}
	}

	return null;
}

function formatInstallHint(group: PackageGroup): string {
	return `qcp packages install ${group} --yes`;
}

function writeDelimitedRows(
	rows: readonly Record<string, unknown>[],
	filePath: string,
	delimiter: "," | "\t",
): void {
	ensureParentDir(filePath);
	const columns = collectColumns(rows);
	const lines = [
		columns.map((column) => encodeDelimitedValue(column, delimiter)).join(delimiter),
		...rows.map((row) =>
			columns
				.map((column) => encodeDelimitedValue(row[column], delimiter))
				.join(delimiter),
		),
	];
	writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8");
}

function readDelimitedRows(
	filePath: string,
	delimiter: "," | "\t",
): TransferImportRows {
	const raw = readFileSync(filePath, "utf-8");
	const records = parseDelimited(raw, delimiter);
	const [header, ...body] = records;
	const columns = (header ?? [])
		.map((column) => sanitizeColumnName(column))
		.filter((column) => column.length > 0);
	if (columns.length === 0) {
		throw new Error("Import file does not contain a header row.");
	}

	return {
		columns,
		rows: body
			.filter((values) => values.some((value) => value.length > 0))
			.map((values) =>
				Object.fromEntries(
					columns.map((column, index) => [column, values[index] ?? ""]),
				),
			),
	};
}

function writeJsonRows(
	rows: readonly Record<string, unknown>[],
	filePath: string,
): void {
	ensureParentDir(filePath);
	writeFileSync(filePath, `${JSON.stringify(rows, null, 2)}\n`, "utf-8");
}

function readJsonRows(filePath: string): TransferImportRows {
	const parsed: unknown = JSON.parse(readFileSync(filePath, "utf-8"));
	if (!Array.isArray(parsed)) {
		throw new Error("JSON import files must contain an array of objects.");
	}
	const rows = parsed.map((value) => normalizeImportRow(value));
	return { rows, columns: collectColumns(rows) };
}

function writeJsonlRows(
	rows: readonly Record<string, unknown>[],
	filePath: string,
): void {
	ensureParentDir(filePath);
	writeFileSync(
		filePath,
		rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
		"utf-8",
	);
}

function readJsonlRows(filePath: string): TransferImportRows {
	const rows = readFileSync(filePath, "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => normalizeImportRow(JSON.parse(line) as unknown));
	return { rows, columns: collectColumns(rows) };
}

async function writeParquetRows(
	rows: readonly Record<string, unknown>[],
	filePath: string,
): Promise<void> {
	ensureParentDir(filePath);
	const parquet = await importPackageFromStore<ParquetModule>("parquetjs-lite");
	const columns = collectColumns(rows);
	const schema = new parquet.ParquetSchema(
		Object.fromEntries(
			columns.map((column) => [column, { type: "UTF8", optional: true }]),
		),
	);
	const writer = await parquet.ParquetWriter.openFile(schema, filePath);
	try {
		for (const row of rows) {
			await writer.appendRow(
				Object.fromEntries(
					columns.map((column) => [column, stringifyCell(row[column])]),
				),
			);
		}
	} finally {
		await writer.close();
	}
}

async function readParquetRows(filePath: string): Promise<TransferImportRows> {
	const parquet = await importPackageFromStore<ParquetModule>("parquetjs-lite");
	const reader = await parquet.ParquetReader.openFile(filePath);
	try {
		const cursor = reader.getCursor();
		const rows: Record<string, unknown>[] = [];
		let record = await cursor.next();
		while (record) {
			rows.push(normalizeImportRow(record));
			record = await cursor.next();
		}
		return { rows, columns: collectColumns(rows) };
	} finally {
		await reader.close();
	}
}

async function writeSqliteRows(
	rows: readonly Record<string, unknown>[],
	filePath: string,
): Promise<void> {
	ensureParentDir(filePath);
	const libsql = await importPackageFromStore<LibsqlModule>("@libsql/client");
	const client = libsql.createClient({ url: pathToFileURL(filePath).href });
	const columns = collectColumns(rows);
	try {
		await client.execute("DROP TABLE IF EXISTS qcp_export");
		await client.execute(
			`CREATE TABLE qcp_export (${columns
				.map((column) => `${quoteSqliteIdentifier(column)} TEXT`)
				.join(", ")})`,
		);
		for (const row of rows) {
			await client.execute({
				sql: `INSERT INTO qcp_export (${columns
					.map(quoteSqliteIdentifier)
					.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
				args: columns.map((column) => stringifyCell(row[column])),
			});
		}
	} finally {
		client.close();
	}
}

async function readSqliteRows(filePath: string): Promise<TransferImportRows> {
	const libsql = await importPackageFromStore<LibsqlModule>("@libsql/client");
	const client = libsql.createClient({ url: pathToFileURL(filePath).href });
	try {
		const tables = await client.execute(
			"SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 1",
		);
		const tableName = tables.rows[0]?.name;
		if (typeof tableName !== "string") {
			throw new Error("SQLite import file does not contain a user table.");
		}
		const result = await client.execute(
			`SELECT * FROM ${quoteSqliteIdentifier(tableName)}`,
		);
		const rows = result.rows.map((row) => normalizeImportRow(row));
		return { rows, columns: collectColumns(rows) };
	} finally {
		client.close();
	}
}

async function writePandasPickleRows(
	rows: readonly Record<string, unknown>[],
	filePath: string,
): Promise<void> {
	ensureParentDir(filePath);
	const pyodideModule = await importPackageFromStore<PyodideModule>("pyodide");
	const pyodide = await pyodideModule.loadPyodide();
	await pyodide.loadPackage("pandas");
	const payload = Buffer.from(JSON.stringify(rows), "utf-8").toString("base64");
	const virtualPath = "/tmp/qcp-export.pd";
	await pyodide.runPythonAsync(
		[
			"import base64",
			"import json",
			"import pandas as pd",
			`payload = ${JSON.stringify(payload)}`,
			"rows = json.loads(base64.b64decode(payload).decode('utf-8'))",
			"df = pd.DataFrame(rows)",
			`df.to_pickle(${JSON.stringify(virtualPath)})`,
		].join("\n"),
	);
	writeFileSync(filePath, pyodide.FS.readFile(virtualPath, { encoding: "binary" }));
}

function writeSqlDumpRows(
	rows: readonly Record<string, unknown>[],
	filePath: string,
): void {
	ensureParentDir(filePath);
	const columns = collectColumns(rows);
	const lines = [
		"-- qcp export",
		"CREATE TABLE qcp_export (",
		columns
			.map((column, index) => {
				const suffix = index === columns.length - 1 ? "" : ",";
				return `  ${quoteSqliteIdentifier(column)} text${suffix}`;
			})
			.join("\n"),
		");",
		...rows.map(
			(row) =>
				`INSERT INTO qcp_export (${columns
					.map(quoteSqliteIdentifier)
					.join(", ")}) VALUES (${columns
					.map((column) => quoteSqlLiteral(row[column]))
					.join(", ")});`,
		),
	];
	writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8");
}

function readSqlDumpRows(filePath: string): TransferImportRows {
	const raw = readFileSync(filePath, "utf-8");
	if (raw.includes("\0")) {
		throw new Error(
			"PostgreSQL dump import supports plain SQL dumps only, not binary custom or tar archives.",
		);
	}

	const columns = readSqlDumpColumns(raw);
	const rows = readSqlDumpInsertRows(raw, columns);
	if (columns.length === 0) {
		throw new Error(
			"PostgreSQL dump import requires CREATE TABLE or INSERT statements with column names.",
		);
	}
	return { columns, rows };
}

function readSqlDumpColumns(raw: string): string[] {
	const insertMatch = /INSERT\s+INTO\s+(?:"[^"]+"|\S+)(?:\s*\.\s*(?:"[^"]+"|\S+))?\s*\(([^)]+)\)\s+VALUES/is.exec(
		raw,
	);
	if (insertMatch?.[1]) return parseSqlIdentifierList(insertMatch[1]);

	const createMatch = /CREATE\s+TABLE\s+(?:"[^"]+"|\S+)(?:\s*\.\s*(?:"[^"]+"|\S+))?\s*\(([\s\S]*?)\);/i.exec(
		raw,
	);
	if (!createMatch?.[1]) return [];

	return createMatch[1]
		.split("\n")
		.map((line) => line.trim().replace(/,$/, ""))
		.filter((line) => line.length > 0)
		.filter((line) => !/^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|EXCLUDE)\b/i.test(line))
		.map((line) => parseSqlIdentifier(line))
		.filter((column) => column.length > 0);
}

function readSqlDumpInsertRows(
	raw: string,
	columns: readonly string[],
): Record<string, unknown>[] {
	const rows: Record<string, unknown>[] = [];
	const insertPattern =
		/INSERT\s+INTO\s+(?:"[^"]+"|\S+)(?:\s*\.\s*(?:"[^"]+"|\S+))?\s*(?:\(([^)]+)\))?\s+VALUES\s*([\s\S]*?);/gi;
	let match = insertPattern.exec(raw);
	while (match) {
		const insertColumns = match[1]
			? parseSqlIdentifierList(match[1])
			: [...columns];
		const values = parseSqlValues(match[2] ?? "");
		for (const tuple of values) {
			rows.push(
				Object.fromEntries(
					insertColumns.map((column, index) => [column, tuple[index] ?? null]),
				),
			);
		}
		match = insertPattern.exec(raw);
	}
	return rows;
}

function parseSqlIdentifierList(raw: string): string[] {
	return raw
		.split(",")
		.map((item) => parseSqlIdentifier(item.trim()))
		.filter((item) => item.length > 0);
}

function parseSqlIdentifier(raw: string): string {
	const quoted = /^"((?:[^"]|"")+)"/.exec(raw);
	if (quoted?.[1]) return sanitizeColumnName(quoted[1].replace(/""/g, '"'));
	const bare = /^([a-zA-Z_][a-zA-Z0-9_$]*)/.exec(raw);
	return bare?.[1] ? sanitizeColumnName(bare[1]) : "";
}

function parseSqlValues(raw: string): unknown[][] {
	const tuples: unknown[][] = [];
	let index = 0;
	while (index < raw.length) {
		if (raw[index] !== "(") {
			index++;
			continue;
		}
		const parsed = parseSqlTuple(raw, index + 1);
		tuples.push(parsed.values);
		index = parsed.nextIndex;
	}
	return tuples;
}

function parseSqlTuple(
	raw: string,
	startIndex: number,
): { readonly values: unknown[]; readonly nextIndex: number } {
	const values: unknown[] = [];
	let current = "";
	let quoted = false;
	let index = startIndex;
	while (index < raw.length) {
		const char = raw[index] ?? "";
		const next = raw[index + 1] ?? "";
		if (quoted) {
			if (char === "'" && next === "'") {
				current += "'";
				index += 2;
				continue;
			}
			if (char === "'") {
				quoted = false;
				index++;
				continue;
			}
			current += char;
			index++;
			continue;
		}

		if (char === "'") {
			quoted = true;
		} else if (char === ",") {
			values.push(parseSqlScalar(current));
			current = "";
		} else if (char === ")") {
			values.push(parseSqlScalar(current));
			return { values, nextIndex: index + 1 };
		} else {
			current += char;
		}
		index++;
	}
	throw new Error("Malformed PostgreSQL dump INSERT values.");
}

function parseSqlScalar(raw: string): unknown {
	const trimmed = raw.trim();
	if (/^NULL$/i.test(trimmed)) return null;
	if (/^(TRUE|FALSE)$/i.test(trimmed)) return /^TRUE$/i.test(trimmed);
	if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
	return trimmed;
}

function normalizeImportRow(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Import rows must be JSON objects.");
	}
	return Object.fromEntries(
		Object.entries(value).map(([key, rowValue]) => [
			sanitizeColumnName(key),
			rowValue,
		]),
	);
}

function collectColumns(rows: readonly Record<string, unknown>[]): string[] {
	const columns = new Set<string>();
	for (const row of rows) {
		for (const key of Object.keys(row)) {
			const column = sanitizeColumnName(key);
			if (column) columns.add(column);
		}
	}
	return [...columns];
}

function sanitizeColumnName(value: string): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "");
	if (!normalized) return "";
	return /^[a-z_]/.test(normalized) ? normalized : `col_${normalized}`;
}

function encodeDelimitedValue(
	value: unknown,
	delimiter: "," | "\t",
): string {
	const text = stringifyCell(value);
	const needsQuotes =
		text.includes(delimiter) ||
		text.includes("\n") ||
		text.includes("\r") ||
		text.includes('"');
	if (!needsQuotes) return text;
	return `"${text.replace(/"/g, '""')}"`;
}

function stringifyCell(value: unknown): string {
	if (value === null || typeof value === "undefined") return "";
	return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function quoteSqliteIdentifier(identifier: string): string {
	return `"${identifier.replace(/"/g, '""')}"`;
}

function quoteSqlLiteral(value: unknown): string {
	if (value === null || typeof value === "undefined") return "NULL";
	return `'${stringifyCell(value).replace(/'/g, "''")}'`;
}

function parseDelimited(raw: string, delimiter: "," | "\t"): string[][] {
	const rows: string[][] = [];
	let current = "";
	let row: string[] = [];
	let quoted = false;

	for (let index = 0; index < raw.length; index++) {
		const char = raw[index] ?? "";
		const next = raw[index + 1] ?? "";
		if (quoted) {
			if (char === '"' && next === '"') {
				current += '"';
				index++;
			} else if (char === '"') {
				quoted = false;
			} else {
				current += char;
			}
			continue;
		}

		if (char === '"') {
			quoted = true;
		} else if (char === delimiter) {
			row.push(current);
			current = "";
		} else if (char === "\n") {
			row.push(current.replace(/\r$/, ""));
			rows.push(row);
			row = [];
			current = "";
		} else {
			current += char;
		}
	}

	if (current.length > 0 || row.length > 0) {
		row.push(current.replace(/\r$/, ""));
		rows.push(row);
	}

	return rows;
}

function ensureParentDir(filePath: string): void {
	const dir = dirname(filePath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
