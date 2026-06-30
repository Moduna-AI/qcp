import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ActiveDatabaseConnection,
	DatabaseSchema,
} from "@/types/index.js";
import { SchemaCatalogStore } from "./catalog-store.js";

const schema: DatabaseSchema = {
	scannedAt: "2026-06-30T00:00:00.000Z",
	databaseName: "app",
	tableCount: 1,
	tables: [
		{
			schema: "public",
			name: "users",
			columns: [],
			primaryKeys: [],
			foreignKeys: [],
			indexes: [],
		},
	],
};

const connection: ActiveDatabaseConnection = {
	id: "prod",
	name: "prod",
	databaseType: "other-postgres",
	databaseUrl: "postgres://prod/app",
};

describe("SchemaCatalogStore", () => {
	test("upserts and loads schema entries by connection", () => {
		const store = createStore();

		store.upsert(connection, schema);

		expect(store.get("prod")?.schema.databaseName).toBe("app");
		expect(store.list()).toHaveLength(1);
	});

	test("removes schema entries by connection id", () => {
		const store = createStore();
		store.upsert(connection, schema);

		store.remove("prod");

		expect(store.list()).toEqual([]);
	});

	test("migrates legacy schema when catalog is missing", () => {
		const dir = mkdtempSync(join(tmpdir(), "qcp-schema-"));
		mkdirSync(dir, { recursive: true });
		const catalogPath = join(dir, "schemas.json");
		const legacyPath = join(dir, "schema.json");
		writeFileSync(legacyPath, JSON.stringify(schema, null, 2));

		const store = new SchemaCatalogStore({
			catalogPath,
			legacySchemaPath: legacyPath,
		});
		const migrated = store.migrateLegacyIfNeeded(connection);

		expect(migrated?.connectionName).toBe("prod");
		expect(store.get("prod")?.databaseName).toBe("app");
	});
});

function createStore(): SchemaCatalogStore {
	const dir = mkdtempSync(join(tmpdir(), "qcp-schema-"));
	return new SchemaCatalogStore({
		catalogPath: join(dir, "schemas.json"),
		legacySchemaPath: join(dir, "schema.json"),
	});
}
