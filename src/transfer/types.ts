import type { PackageGroup } from "@/packages/lazy-packages.js";
import type { QueryResult } from "@/types/index.js";

export type DatabaseTransferFormat =
	| "csv"
	| "tsv"
	| "json"
	| "jsonl"
	| "parquet"
	| "sqlite"
	| "pandas"
	| "postgres-dump";

export type DatabaseTransferDirection = "import" | "export";

export interface FormatDetectionResult {
	readonly format: DatabaseTransferFormat;
	readonly extension: string;
}

export interface TransferFormatAdapter {
	readonly format: DatabaseTransferFormat;
	readonly label: string;
	readonly extensions: readonly string[];
	readonly packageGroup?: PackageGroup;
	readonly importSupported: boolean;
	readonly exportSupported: boolean;
	exportRows?(
		rows: readonly Record<string, unknown>[],
		filePath: string,
	): void | Promise<void>;
	importRows?(filePath: string): Promise<TransferImportRows>;
}

export interface TransferImportRows {
	readonly rows: readonly Record<string, unknown>[];
	readonly columns: readonly string[];
}

export interface TransferTableReference {
	readonly schema?: string;
	readonly table: string;
}

export interface TransferExportRequest {
	readonly filePath: string;
	readonly format?: DatabaseTransferFormat;
	readonly sql?: string;
	readonly table?: TransferTableReference;
}

export interface TransferImportRequest {
	readonly filePath: string;
	readonly format?: DatabaseTransferFormat;
	readonly tableName?: string;
	readonly schemaName?: string;
}

export type TransferResult =
	| {
			readonly ok: true;
			readonly direction: DatabaseTransferDirection;
			readonly format: DatabaseTransferFormat;
			readonly filePath: string;
			readonly rowCount: number;
			readonly tableName?: string;
			readonly fields?: string[];
			readonly schemaRefreshed?: boolean;
	  }
	| {
			readonly ok: false;
			readonly direction: DatabaseTransferDirection;
			readonly format?: DatabaseTransferFormat;
			readonly filePath?: string;
			readonly error: string;
	  };

export type TransferQueryExecutor = (
	sql: string,
) => Promise<QueryResult | TransferResult>;

export type TransferImportExecutor = (input: {
	readonly schemaName: string;
	readonly tableName: string;
	readonly columns: readonly string[];
	readonly rows: readonly Record<string, unknown>[];
}) => Promise<{ readonly rowCount: number }>;

export type TransferTableExists = (input: {
	readonly schemaName: string;
	readonly tableName: string;
}) => Promise<boolean>;
