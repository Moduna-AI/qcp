import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
	SqliteDatabaseImporter,
	type SqliteDatabaseImportResult,
} from "@/transfer/sqlite-database-import.js";
import type { DatabaseType } from "@/types/index.js";

const sqliteImportResultSchema = z.discriminatedUnion("ok", [
	z.object({
		ok: z.literal(true),
		sourcePath: z.string(),
		targetSchema: z.literal("public"),
		tableCount: z.number().int().nonnegative(),
		totalRowCount: z.number().int().nonnegative(),
		tables: z.array(
			z.object({
				sourceTable: z.string(),
				targetTable: z.string(),
				rowCount: z.number().int().nonnegative(),
			}),
		),
		durationMs: z.number().int().nonnegative(),
		schemaRefreshed: z.boolean(),
	}),
	z.object({
		ok: z.literal(false),
		category: z.enum([
			"invalid_source",
			"outside_workspace",
			"unsupported_source",
			"empty_database",
			"identifier_collision",
			"destination_conflict",
			"migration_failed",
		]),
		sourcePath: z.string().optional(),
		error: z.string(),
		rolledBack: z.boolean(),
	}),
]);

export interface SupervisorSqliteImporter {
	importDatabase(filePath: string): Promise<SqliteDatabaseImportResult>;
}

export interface CreateSupervisorToolsOptions {
	readonly databaseType: DatabaseType;
	readonly databaseUrl: string;
	readonly cwd?: string;
	readonly importer?: SupervisorSqliteImporter;
	readonly refreshSchema?: () => Promise<void>;
}

export function createSupervisorTools(options: CreateSupervisorToolsOptions): {
	readonly qcp_import_sqlite_database: ReturnType<typeof createTool>;
} {
	const importer =
		options.importer ??
		new SqliteDatabaseImporter({
			databaseUrl: options.databaseUrl,
			cwd: options.cwd,
			refreshSchema: options.refreshSchema,
		});

	return {
		qcp_import_sqlite_database: createTool({
			id: "qcp_import_sqlite_database",
			description:
				"Import every user table, relationship, constraint, index, and row from a local SQLite database into the public schema of the active Supabase connection. Use only for full .db, .sqlite, or .sqlite3 database imports, not single-table files.",
			strict: true,
			inputSchema: z.object({
				filePath: z
					.string()
					.min(1)
					.describe("Workspace-relative path to the SQLite database file"),
			}),
			outputSchema: sqliteImportResultSchema,
			requireApproval: true,
			mcp: {
				annotations: {
					title: "Import SQLite Database into Supabase",
					readOnlyHint: false,
					destructiveHint: false,
					idempotentHint: false,
					openWorldHint: true,
				},
			},
			execute: async ({ filePath }) => {
				if (options.databaseType !== "supabase") {
					return {
						ok: false,
						category: "migration_failed",
						error:
							"Full SQLite database import requires the active qcp connection to be Supabase.",
						rolledBack: false,
					} satisfies SqliteDatabaseImportResult;
				}
				const result = await importer.importDatabase(filePath);
				return result.ok
					? { ...result, tables: [...result.tables] }
					: { ...result };
			},
		}),
	};
}
