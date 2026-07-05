import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import postgres from "postgres";
import { executeQuery } from "@/db/index.js";
import type { DatabaseSchema } from "@/types/index.js";
import {
	assertAdapterAvailable,
	detectTransferFormat,
	getTransferFormatAdapter,
} from "./format-adapters.js";
import type {
	DatabaseTransferFormat,
	TransferExportRequest,
	TransferImportExecutor,
	TransferImportRequest,
	TransferQueryExecutor,
	TransferResult,
	TransferTableExists,
} from "./types.js";

export interface DatabaseTransferServiceOptions {
	readonly databaseUrl: string;
	readonly schema: DatabaseSchema;
	readonly cwd?: string;
	readonly queryExecutor?: TransferQueryExecutor;
	readonly importExecutor?: TransferImportExecutor;
	readonly tableExists?: TransferTableExists;
	readonly refreshSchema?: () => Promise<void>;
}

export class DatabaseTransferService {
	private readonly databaseUrl: string;
	private readonly schema: DatabaseSchema;
	private readonly cwd: string;
	private readonly queryExecutor: TransferQueryExecutor;
	private readonly importExecutor: TransferImportExecutor;
	private readonly tableExists: TransferTableExists;
	private readonly refreshSchema?: () => Promise<void>;

	public constructor(options: DatabaseTransferServiceOptions) {
		this.databaseUrl = options.databaseUrl;
		this.schema = options.schema;
		this.cwd = options.cwd ?? process.cwd();
		this.queryExecutor =
			options.queryExecutor ??
			(async (sql) => executeQuery(this.databaseUrl, sql, 60_000));
		this.importExecutor =
			options.importExecutor ?? ((input) => this.insertRows(input));
		this.tableExists =
			options.tableExists ?? ((input) => this.databaseTableExists(input));
		this.refreshSchema = options.refreshSchema;
	}

	public async exportData(
		request: TransferExportRequest,
	): Promise<TransferResult> {
		const filePath = this.resolveWorkspacePath(request.filePath, "export");
		const detected = detectTransferFormat(filePath, request.format);
		if (!detected) {
			return {
				ok: false,
				direction: "export",
				filePath,
				error:
					"Export format is required. Include a supported file extension or format.",
			};
		}

		const adapter = getTransferFormatAdapter(detected.format);
		const unavailable = assertAdapterAvailable(adapter, "export");
		if (unavailable) {
			return this.failure("export", detected.format, filePath, unavailable);
		}
		if (!adapter.exportRows) {
			return this.failure(
				"export",
				detected.format,
				filePath,
				`${adapter.label} export adapter is unavailable.`,
			);
		}

		const sql = this.buildExportSql(request);
		const result = await this.queryExecutor(sql);
		if ("ok" in result && result.ok === false) return result;
		if ("ok" in result && result.ok === true) {
			return this.failure(
				"export",
				detected.format,
				filePath,
				"Export query returned an unexpected transfer result.",
			);
		}

		try {
			await adapter.exportRows(result.rows, filePath);
		} catch (err: unknown) {
			return this.failure(
				"export",
				detected.format,
				filePath,
				formatTransferError(err),
			);
		}
		return {
			ok: true,
			direction: "export",
			format: detected.format,
			filePath,
			rowCount: result.rowCount,
			fields: result.fields,
		};
	}

	public async importData(
		request: TransferImportRequest,
	): Promise<TransferResult> {
		const filePath = this.resolveWorkspacePath(request.filePath, "import");
		if (!existsSync(filePath)) {
			return this.failure(
				"import",
				request.format,
				filePath,
				"File not found.",
			);
		}

		const detected = detectTransferFormat(filePath, request.format);
		if (!detected) {
			return {
				ok: false,
				direction: "import",
				filePath,
				error:
					"Import format is required. Include a supported file extension or format.",
			};
		}

		const adapter = getTransferFormatAdapter(detected.format);
		const unavailable = assertAdapterAvailable(adapter, "import");
		if (unavailable) {
			return this.failure("import", detected.format, filePath, unavailable);
		}
		if (!adapter.importRows) {
			return this.failure(
				"import",
				detected.format,
				filePath,
				`${adapter.label} import adapter is unavailable.`,
			);
		}

		const schemaName = normalizeIdentifier(request.schemaName ?? "public");
		const tableName = normalizeIdentifier(
			request.tableName ?? deriveTableNameFromPath(filePath),
		);
		const exists = await this.tableExists({ schemaName, tableName });
		if (exists) {
			return this.failure(
				"import",
				detected.format,
				filePath,
				`Table already exists: ${schemaName}.${tableName}. Choose a new table name.`,
			);
		}

		let imported: Awaited<ReturnType<NonNullable<typeof adapter.importRows>>>;
		try {
			imported = await adapter.importRows(filePath);
		} catch (err: unknown) {
			return this.failure(
				"import",
				detected.format,
				filePath,
				formatTransferError(err),
			);
		}
		if (imported.columns.length === 0) {
			return this.failure(
				"import",
				detected.format,
				filePath,
				"Import file does not contain any columns.",
			);
		}

		const created = await this.importExecutor({
			schemaName,
			tableName,
			columns: imported.columns.map((column) => normalizeIdentifier(column)),
			rows: imported.rows,
		});
		if (this.refreshSchema) await this.refreshSchema();

		return {
			ok: true,
			direction: "import",
			format: detected.format,
			filePath,
			rowCount: created.rowCount,
			tableName: `${schemaName}.${tableName}`,
			schemaRefreshed: Boolean(this.refreshSchema),
		};
	}

	private buildExportSql(request: TransferExportRequest): string {
		if (request.sql) return request.sql;
		if (!request.table) {
			throw new Error("Export requires either a SQL query or a table name.");
		}
		const schemaName = normalizeIdentifier(request.table.schema ?? "public");
		const tableName = normalizeIdentifier(request.table.table);
		return `SELECT * FROM ${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
	}

	private resolveWorkspacePath(filePath: string, action: string): string {
		const workspace = resolve(this.cwd);
		const resolved = resolve(workspace, filePath);
		const relativePath = relative(workspace, resolved);
		const outsideWorkspace =
			relativePath === ".." ||
			relativePath.startsWith(`..${sep}`) ||
			isAbsolute(relativePath);
		if (outsideWorkspace) {
			throw new Error(
				`Refusing to ${action} outside the current working directory: ${filePath}`,
			);
		}
		return resolved;
	}

	private async databaseTableExists(input: {
		readonly schemaName: string;
		readonly tableName: string;
	}): Promise<boolean> {
		return this.schema.tables.some(
			(table) =>
				table.schema === input.schemaName && table.name === input.tableName,
		);
	}

	private async insertRows(input: {
		readonly schemaName: string;
		readonly tableName: string;
		readonly columns: readonly string[];
		readonly rows: readonly Record<string, unknown>[];
	}): Promise<{ readonly rowCount: number }> {
		const db = postgres(this.databaseUrl, {
			max: 1,
			connect_timeout: 10,
			connection: { application_name: "qcp-import" },
		});
		try {
			const tableId = `${quoteIdentifier(input.schemaName)}.${quoteIdentifier(
				input.tableName,
			)}`;
			const columnDefs = input.columns
				.map((column) => `${quoteIdentifier(column)} text`)
				.join(", ");
			await db.unsafe(`CREATE TABLE ${tableId} (${columnDefs})`);
			if (input.rows.length > 0) {
				const columnList = input.columns.map(quoteIdentifier).join(", ");
				const values = input.rows
					.map(
						(row) =>
							`(${input.columns
								.map((column) => quoteLiteral(row[column]))
								.join(", ")})`,
					)
					.join(", ");
				await db.unsafe(
					`INSERT INTO ${tableId} (${columnList}) VALUES ${values}`,
				);
			}
			return { rowCount: input.rows.length };
		} finally {
			await db.end({ timeout: 2 }).catch(() => {});
		}
	}

	private failure(
		direction: "import" | "export",
		format: DatabaseTransferFormat | undefined,
		filePath: string | undefined,
		error: string,
	): TransferResult {
		return { ok: false, direction, format, filePath, error };
	}
}

export function normalizeIdentifier(value: string): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "");
	if (!normalized) {
		throw new Error("Identifier cannot be empty.");
	}
	return /^[a-z_]/.test(normalized) ? normalized : `t_${normalized}`;
}

export function deriveTableNameFromPath(filePath: string): string {
	const base = filePath.split(/[\\/]/).at(-1) ?? "import";
	const withoutExtension = base.replace(/\.[^.]+$/, "");
	return normalizeIdentifier(withoutExtension);
}

function quoteIdentifier(identifier: string): string {
	return `"${identifier.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: unknown): string {
	if (value === null || typeof value === "undefined") return "NULL";
	const text =
		typeof value === "object" ? JSON.stringify(value) : String(value);
	return `'${text.replace(/'/g, "''")}'`;
}

function formatTransferError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
