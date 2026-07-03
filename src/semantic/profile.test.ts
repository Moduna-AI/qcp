import { describe, expect, test } from "bun:test";
import type {
	ActiveDatabaseConnection,
	DatabaseSchema,
	QueryResult,
} from "@/types/index.js";
import { SemanticSchemaIndexer, semanticObjectId } from "./indexer.js";
import { SemanticValueProfiler } from "./profile.js";
import { SemanticStore } from "./store.js";
import { createInMemorySemanticSqlClient } from "./test-client.js";

describe("SemanticValueProfiler", () => {
	test("profiles selected non-sensitive columns and skips sensitive patterns", async () => {
		const store = new SemanticStore({
			client: createInMemorySemanticSqlClient(),
		});
		const executedSql: string[] = [];

		try {
			await new SemanticSchemaIndexer(store).sync(connection, schema());
			const profiler = new SemanticValueProfiler({
				store,
				databaseUrl: "postgres://example/app",
				sensitivePatterns: ["email"],
				queryExecutor: async (_databaseUrl, sql) => {
					executedSql.push(sql);
					return resultForSql(sql);
				},
			});

			const result = await profiler.profile({
				connectionId: connection.id,
				schemaName: "public",
				tableName: "users",
				columnNames: ["status", "email"],
			});

			expect(result.profiledColumns).toEqual(["status"]);
			expect(result.skippedColumns).toEqual([
				{
					columnName: "email",
					reason: "matches sensitive table or column pattern",
				},
			]);
			expect(executedSql).toHaveLength(3);

			const profile = await store.getValueProfile(
				semanticObjectId({
					connectionId: connection.id,
					objectType: "column",
					schemaName: "public",
					tableName: "users",
					columnName: "status",
				}),
			);
			expect(profile?.distinctCount).toBe(2);
			expect(profile?.sampleValues).toEqual(["active", "inactive"]);
			expect(profile?.topValues[0]).toEqual({ value: "active", frequency: 10 });
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

function resultForSql(sql: string): QueryResult {
	if (sql.includes("COUNT(DISTINCT")) {
		return queryResult([{ distinct_count: "2" }]);
	}
	if (sql.includes("COUNT(*)")) {
		return queryResult([
			{ value: "active", frequency: "10" },
			{ value: "inactive", frequency: "3" },
		]);
	}
	return queryResult([{ value: "active" }, { value: "inactive" }]);
}

function queryResult(rows: Record<string, unknown>[]): QueryResult {
	return {
		rows,
		rowCount: rows.length,
		fields: rows[0] ? Object.keys(rows[0]) : [],
		executionTimeMs: 1,
	};
}

function schema(): DatabaseSchema {
	return {
		scannedAt: "2026-07-03T00:00:00.000Z",
		databaseName: "app",
		tableCount: 1,
		tables: [
			{
				schema: "public",
				name: "users",
				primaryKeys: ["id"],
				columns: [
					{ name: "id", type: "integer", nullable: false, isPrimaryKey: true },
					{ name: "status", type: "text", nullable: true, isPrimaryKey: false },
					{ name: "email", type: "text", nullable: true, isPrimaryKey: false },
				],
				foreignKeys: [],
				indexes: [],
			},
		],
	};
}
