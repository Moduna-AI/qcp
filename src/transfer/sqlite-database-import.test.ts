import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildSqliteMigrationPlan,
	mapSqliteTypeToPostgres,
	resolveSqliteSourcePath,
	SqliteDatabaseImporter,
	type SqliteMigrationExecutor,
	toSnakeCase,
} from "./sqlite-database-import.js";

describe("SQLite database import", () => {
	test("normalizes Chinook identifiers and maps declared types", () => {
		expect(toSnakeCase("InvoiceLine")).toBe("invoice_line");
		expect(toSnakeCase("InvoiceId")).toBe("invoice_id");
		expect(mapSqliteTypeToPostgres("NVARCHAR(160)")).toBe("varchar(160)");
		expect(mapSqliteTypeToPostgres("NUMERIC(10,2)")).toBe("numeric(10,2)");
		expect(mapSqliteTypeToPostgres("DATETIME")).toBe("timestamp");
		expect(mapSqliteTypeToPostgres("BLOB")).toBe("bytea");
	});

	test("inspects tables, relationships, uniqueness, indexes, and rows", async () => {
		const fixture = createFixture();
		const plan = await buildSqliteMigrationPlan(fixture.filePath);

		expect(plan.tables).toHaveLength(2);
		const artist = plan.tables.find((table) => table.targetName === "artist");
		const album = plan.tables.find((table) => table.targetName === "album");
		expect(artist?.primaryKey).toEqual(["artist_id"]);
		expect(artist?.indexes.some((index) => index.unique)).toBe(true);
		expect(album?.foreignKeys[0]).toMatchObject({
			sourceColumns: ["artist_id"],
			targetTable: "artist",
			targetColumns: ["artist_id"],
		});
		expect(
			album?.indexes.some((index) => index.columns[0] === "artist_id"),
		).toBe(true);
		expect(album?.rows).toEqual([
			{ album_id: 10, title: "Example", artist_id: 1 },
		]);
	});

	test("rejects paths outside the workspace, including symlinks", () => {
		const fixture = createFixture();
		expect(() =>
			resolveSqliteSourcePath(fixture.cwd, "../outside.sqlite"),
		).toThrow("outside");

		const outside = join(import.meta.dir, "../../Chinook_Sqlite.sqlite");
		const link = join(fixture.cwd, "linked.sqlite");
		symlinkSync(outside, link);
		expect(() => resolveSqliteSourcePath(fixture.cwd, "linked.sqlite")).toThrow(
			"outside",
		);
	});

	test("returns a structured success summary through an injected executor", async () => {
		const fixture = createFixture();
		let refreshed = false;
		const executor: SqliteMigrationExecutor = {
			execute: async (plan) =>
				plan.tables.map((table) => ({
					sourceTable: table.sourceName,
					targetTable: table.targetName,
					rowCount: table.rows.length,
				})),
		};
		const importer = new SqliteDatabaseImporter({
			databaseUrl: "postgres://unused",
			cwd: fixture.cwd,
			executor,
			refreshSchema: async () => {
				refreshed = true;
			},
		});

		const result = await importer.importDatabase("fixture.sqlite");

		expect(result).toMatchObject({
			ok: true,
			targetSchema: "public",
			tableCount: 2,
			totalRowCount: 2,
			schemaRefreshed: true,
		});
		expect(refreshed).toBe(true);
	});

	test("reports migration failures as rolled back and caps diagnostics", async () => {
		const fixture = createFixture();
		const executor: SqliteMigrationExecutor = {
			execute: async () => {
				throw new Error("x".repeat(3_000));
			},
		};
		const importer = new SqliteDatabaseImporter({
			databaseUrl: "postgres://unused",
			cwd: fixture.cwd,
			executor,
		});

		const result = await importer.importDatabase("fixture.sqlite");

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.category).toBe("migration_failed");
		expect(result.rolledBack).toBe(true);
		expect(result.error.length).toBeLessThanOrEqual(2_001);
	});
});

function createFixture(): { readonly cwd: string; readonly filePath: string } {
	const cwd = join(
		process.env.TMPDIR ?? "/tmp",
		`qcp-sqlite-import-${crypto.randomUUID()}`,
	);
	mkdirSync(cwd, { recursive: true });
	const filePath = join(cwd, "fixture.sqlite");
	writeFileSync(filePath, "");
	const database = new Database(filePath);
	try {
		database.run(`
			CREATE TABLE Artist (
				ArtistId INTEGER NOT NULL PRIMARY KEY,
				Name NVARCHAR(120) UNIQUE
			);
			CREATE TABLE Album (
				AlbumId INTEGER NOT NULL PRIMARY KEY,
				Title NVARCHAR(160) NOT NULL,
				ArtistId INTEGER NOT NULL,
				FOREIGN KEY (ArtistId) REFERENCES Artist (ArtistId)
			);
			CREATE INDEX IFK_AlbumArtistId ON Album (ArtistId);
			INSERT INTO Artist VALUES (1, 'Example Artist');
			INSERT INTO Album VALUES (10, 'Example', 1);
		`);
	} finally {
		database.close();
	}
	return { cwd, filePath };
}
