import { describe, expect, test } from "bun:test";
import type {
	ActiveDatabaseConnection,
	DatabaseSchema,
} from "@/types/index.js";
import { SemanticSchemaIndexer, semanticObjectId } from "./indexer.js";
import { SemanticContextRetriever } from "./retriever.js";
import { SemanticStore } from "./store.js";
import { createInMemorySemanticSqlClient } from "./test-client.js";

describe("SemanticContextRetriever", () => {
	test("retrieves annotated objects and foreign-key neighbors deterministically", async () => {
		const store = new SemanticStore({
			client: createInMemorySemanticSqlClient(),
		});
		try {
			await new SemanticSchemaIndexer(store).sync(connection, schema());
			const usersTableId = semanticObjectId({
				connectionId: connection.id,
				objectType: "table",
				schemaName: "public",
				tableName: "users",
			});
			await store.addAnnotation({
				objectId: usersTableId,
				description: "Customers who can place orders.",
				businessName: "Customer",
				synonyms: ["customer", "account"],
				source: "cli",
			});

			const context = await new SemanticContextRetriever({ store }).retrieve({
				connectionId: connection.id,
				query: "customer order totals",
				maxObjects: 1,
			});

			const objectNames = context.objects.map((object) =>
				object.columnName
					? `${object.tableName}.${object.columnName}`
					: object.tableName,
			);
			expect(objectNames).toContain("users");
			expect(objectNames).toContain("orders");
			expect(context.relationships).toHaveLength(1);
			expect(
				context.missingObjects.some((object) => object.tableName === "orders"),
			).toBe(true);
			expect(context.objects[0]?.annotation?.businessName).toBe("Customer");
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

function schema(): DatabaseSchema {
	return {
		scannedAt: "2026-07-03T00:00:00.000Z",
		databaseName: "app",
		tableCount: 2,
		tables: [
			{
				schema: "public",
				name: "users",
				primaryKeys: ["id"],
				columns: [
					{ name: "id", type: "integer", nullable: false, isPrimaryKey: true },
					{ name: "email", type: "text", nullable: true, isPrimaryKey: false },
				],
				foreignKeys: [],
				indexes: [],
			},
			{
				schema: "public",
				name: "orders",
				primaryKeys: ["id"],
				columns: [
					{ name: "id", type: "integer", nullable: false, isPrimaryKey: true },
					{
						name: "user_id",
						type: "integer",
						nullable: true,
						isPrimaryKey: false,
					},
					{
						name: "total",
						type: "numeric",
						nullable: true,
						isPrimaryKey: false,
					},
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
