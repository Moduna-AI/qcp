import { pathToFileURL } from "node:url";
import { importPackageFromStore } from "@/packages/lazy-packages.js";

export interface LocalSqliteResult {
	readonly rows: readonly Record<string, unknown>[];
}

export interface LocalSqliteClient {
	execute(
		statement:
			| string
			| { readonly sql: string; readonly args?: readonly unknown[] },
	): Promise<LocalSqliteResult>;
	close(): void | Promise<void>;
}

interface LibsqlModule {
	createClient(options: { readonly url: string }): LocalSqliteClient;
}

interface BunSqliteStatement {
	all(...args: readonly unknown[]): readonly Record<string, unknown>[];
}

interface BunSqliteDatabase {
	query(sql: string): BunSqliteStatement;
	close(): void;
}

interface BunSqliteModule {
	readonly Database: new (path: string) => BunSqliteDatabase;
}

export async function createLocalSqliteClient(
	databasePath: string,
): Promise<LocalSqliteClient> {
	if (typeof Bun !== "undefined") {
		return await createBunSqliteClient(databasePath);
	}

	const libsql = await importPackageFromStore<LibsqlModule>("@libsql/client");
	return libsql.createClient({
		url:
			databasePath === ":memory:"
				? "file::memory:"
				: pathToFileURL(databasePath).href,
	});
}

async function createBunSqliteClient(
	databasePath: string,
): Promise<LocalSqliteClient> {
	const bunSqliteSpecifier = "bun:sqlite";
	const sqlite = (await import(bunSqliteSpecifier)) as BunSqliteModule;
	const database = new sqlite.Database(databasePath);

	return {
		async execute(statement): Promise<LocalSqliteResult> {
			const sql = typeof statement === "string" ? statement : statement.sql;
			const args = typeof statement === "string" ? [] : (statement.args ?? []);
			return { rows: database.query(sql).all(...args) };
		},
		close(): void {
			database.close();
		},
	};
}
