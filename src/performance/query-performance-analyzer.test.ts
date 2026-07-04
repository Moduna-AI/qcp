import { describe, expect, test } from "bun:test";
import type { DatabaseSchema } from "@/types/index.js";
import {
	isLikelySql,
	QueryPerformanceAnalyzer,
} from "./query-performance-analyzer.js";

const schema: DatabaseSchema = {
	scannedAt: "2026-07-03T00:00:00.000Z",
	databaseName: "shop",
	tableCount: 2,
	tables: [
		{
			schema: "public",
			name: "orders",
			columns: [
				column("id", "integer"),
				column("customer_id", "integer"),
				column("status", "text"),
				column("metadata", "jsonb"),
				column("notes", "text"),
				column("created_at", "timestamp"),
				column("updated_at", "timestamp"),
				column("currency", "text"),
				column("subtotal", "numeric"),
				column("tax", "numeric"),
				column("total", "numeric"),
				column("source", "text"),
				column("shipping_address", "jsonb"),
				column("billing_address", "jsonb"),
			],
			primaryKeys: ["id"],
			foreignKeys: [],
			indexes: [
				{ name: "orders_pkey", columns: ["id"], unique: true, primary: true },
			],
			estimatedRows: 2_300_000,
		},
		{
			schema: "public",
			name: "customers",
			columns: [column("id", "integer"), column("email", "text")],
			primaryKeys: ["id"],
			foreignKeys: [],
			indexes: [
				{
					name: "customers_pkey",
					columns: ["id"],
					unique: true,
					primary: true,
				},
			],
			estimatedRows: 10_000,
		},
	],
};

describe("QueryPerformanceAnalyzer", () => {
	test("detects SQL-like input", () => {
		expect(isLikelySql("select * from orders")).toBe(true);
		expect(isLikelySql("WITH latest AS (select 1) select * from latest")).toBe(
			true,
		);
		expect(isLikelySql("show me pending orders")).toBe(false);
	});

	test("suggests a composite index for sequential scan equality filters", () => {
		const analysis = new QueryPerformanceAnalyzer(schema).analyze(
			"select * from orders where customer_id = 5 and status = 'pending'",
			explainPlan({
				"Node Type": "Seq Scan",
				"Relation Name": "orders",
				Schema: "public",
				Alias: "orders",
				Filter: "((customer_id = 5) AND (status = 'pending'::text))",
				"Plan Rows": 180,
				"Total Cost": 340,
			}),
		);

		expect(analysis.suggestedIndexes).toHaveLength(1);
		expect(analysis.suggestedIndexes[0]?.columns).toEqual([
			"customer_id",
			"status",
		]);
		expect(analysis.suggestedIndexes[0]?.suggestionSql).toBe(
			"CREATE INDEX idx_orders_customer_id_status ON orders(customer_id, status);",
		);
	});

	test("does not suggest an index when an existing index covers the columns", () => {
		const indexedSchema: DatabaseSchema = {
			...schema,
			tables: schema.tables.map((table) =>
				table.name === "orders"
					? {
							...table,
							indexes: [
								...table.indexes,
								{
									name: "idx_orders_customer_id_status",
									columns: ["customer_id", "status"],
									unique: false,
									primary: false,
								},
							],
						}
					: table,
			),
		};

		const analysis = new QueryPerformanceAnalyzer(indexedSchema).analyze(
			"select id from orders where customer_id = 5 and status = 'pending'",
			explainPlan({
				"Node Type": "Seq Scan",
				"Relation Name": "orders",
				Schema: "public",
				Filter: "((customer_id = 5) AND (status = 'pending'::text))",
				"Plan Rows": 180,
				"Total Cost": 340,
			}),
		);

		expect(analysis.suggestedIndexes).toHaveLength(0);
	});

	test("warns on SELECT star for wide or heavy tables", () => {
		const analysis = new QueryPerformanceAnalyzer(schema).analyze(
			"select * from orders where id = 1",
			explainPlan({
				"Node Type": "Index Scan",
				"Relation Name": "orders",
				Schema: "public",
				"Plan Rows": 1,
				"Total Cost": 2,
			}),
		);

		expect(analysis.warnings).toHaveLength(1);
		expect(analysis.warnings[0]?.detail).toContain("14 columns");
		expect(analysis.warnings[0]?.detail).toContain("metadata");
	});

	test("extracts join predicate index candidates", () => {
		const analysis = new QueryPerformanceAnalyzer(schema).analyze(
			"select orders.id from orders join customers on orders.customer_id = customers.id",
			explainPlan({
				"Node Type": "Hash Join",
				"Hash Cond": "(orders.customer_id = customers.id)",
				"Plan Rows": 5000,
				"Total Cost": 900,
				Plans: [
					{
						"Node Type": "Seq Scan",
						"Relation Name": "orders",
						Schema: "public",
						"Plan Rows": 2_300_000,
						"Total Cost": 800,
					},
				],
			}),
		);

		expect(
			analysis.suggestedIndexes.some((finding) => finding.table === "orders"),
		).toBe(true);
		expect(
			analysis.suggestedIndexes.some(
				(finding) => finding.table === "customers",
			),
		).toBe(false);
	});
});

function column(name: string, type: string) {
	return {
		name,
		type,
		nullable: false,
		isPrimaryKey: name === "id",
	};
}

function explainPlan(plan: Record<string, unknown>): string {
	return JSON.stringify([
		{
			"QUERY PLAN": [
				{
					Plan: plan,
				},
			],
		},
	]);
}
