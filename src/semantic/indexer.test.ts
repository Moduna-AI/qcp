import { describe, expect, test } from "bun:test";
import type {
	ActiveDatabaseConnection,
	DatabaseSchema,
} from "@/types/index.js";
import { SemanticSchemaIndexer, semanticObjectId } from "./indexer.js";
import { SemanticStore } from "./store.js";
import { createInMemorySemanticSqlClient } from "./test-client.js";

describe("SemanticSchemaIndexer", () => {
	test("syncs structural objects and preserves annotation versions across drift", async () => {
		const store = new SemanticStore({
			client: createInMemorySemanticSqlClient(),
			now: () => new Date("2026-07-03T00:00:00.000Z"),
		});
		const indexer = new SemanticSchemaIndexer(store);

		try {
			const initial = await indexer.sync(connection, schemaV1());
			expect(initial.syncedObjects).toBe(9);
			expect(initial.syncedRelationships).toBe(1);
			expect(initial.changedObjects).toBe(0);

			const usersTableId = semanticObjectId({
				connectionId: connection.id,
				objectType: "table",
				schemaName: "public",
				tableName: "users",
			});
			await store.addAnnotation({
				objectId: usersTableId,
				description: "People or customers using the product.",
				synonyms: ["customer"],
				source: "cli",
			});

			const drifted = await indexer.sync(connection, schemaV2());
			expect(drifted.syncedObjects).toBe(10);
			expect(drifted.changedObjects).toBe(2);
			expect(drifted.staleObjects).toBe(2);

			const usersTable = await store.getObjectById(usersTableId);
			expect(usersTable?.stale).toBe(true);
			const historyBefore = await store.listAnnotationsForObject(usersTableId);
			expect(historyBefore.map((annotation) => annotation.version)).toEqual([
				1,
			]);

			await store.addAnnotation({
				objectId: usersTableId,
				description: "Current customers and account holders.",
				synonyms: ["customer", "account"],
				source: "cli",
			});
			const historyAfter = await store.listAnnotationsForObject(usersTableId);
			expect(historyAfter.map((annotation) => annotation.version)).toEqual([
				1, 2,
			]);
			expect((await store.getObjectById(usersTableId))?.stale).toBe(false);

			const removedOrders = await indexer.sync(
				connection,
				schemaWithoutOrders(),
			);
			expect(removedOrders.inactiveObjects).toBe(5);
			const coverage = await store.getCoverageReport(connection.id);
			expect(coverage.activeObjects).toBe(5);
		} finally {
			await store.close();
		}
	});
});

const connection: ActiveDatabaseConnection = {
	id: "conn-1",
	name: "local",
	databaseType: "other-postgres",
	databaseUrl: "postgres://example/app",
};

function schemaV1(): DatabaseSchema {
	return {
		scannedAt: "2026-07-03T00:00:00.000Z",
		databaseName: "app",
		tableCount: 2,
		tables: [
			{
				schema: "public",
				name: "users",
				primaryKeys: ["id"],
				estimatedRows: 10,
				columns: [
					column("id", "integer", false, true),
					column("email", "text"),
					column("status", "text"),
				],
				foreignKeys: [],
				indexes: [],
			},
			{
				schema: "public",
				name: "orders",
				primaryKeys: ["id"],
				estimatedRows: 20,
				columns: [
					column("id", "integer", false, true),
					column("user_id", "integer"),
					column("total", "numeric"),
					column("status", "text"),
				],
				foreignKeys: [
					{
						constraintName: "orders_user_id_fkey",
						column: "user_id",
						referencedSchema: "public",
						referencedTable: "users",
						referencedColumn: "id",
					},
				],
				indexes: [],
			},
		],
	};
}

function schemaV2(): DatabaseSchema {
	const schema = schemaV1();
	const users = schema.tables[0];
	return {
		...schema,
		tables: [
			{
				...users,
				columns: [
					...users.columns.map((item) =>
						item.name === "status" ? column("status", "varchar") : item,
					),
					column("plan", "text"),
				],
			},
			schema.tables[1],
		],
	};
}

function schemaWithoutOrders(): DatabaseSchema {
	const schema = schemaV2();
	return {
		...schema,
		tableCount: 1,
		tables: [schema.tables[0]],
	};
}

function column(
	name: string,
	type: string,
	nullable = true,
	isPrimaryKey = false,
) {
	return {
		name,
		type,
		nullable,
		defaultValue: undefined,
		isPrimaryKey,
	};
}
