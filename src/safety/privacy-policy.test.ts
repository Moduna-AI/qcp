import { describe, expect, test } from "bun:test";
import type { DatabaseSchema, PostgresPrivacyPolicy } from "@/types/index.js";
import { evaluatePostgresPrivacyPolicy } from "./privacy-policy.js";

const schema: DatabaseSchema = {
	scannedAt: "2026-07-12T00:00:00.000Z",
	databaseName: "app",
	tableCount: 2,
	tables: [
		{
			schema: "public",
			name: "users",
			columns: [column("id"), column("email"), column("display_name")],
			primaryKeys: ["id"],
			foreignKeys: [],
			indexes: [],
		},
		{
			schema: "analytics",
			name: "masked_users",
			columns: [column("email"), column("display_name")],
			primaryKeys: [],
			foreignKeys: [],
			indexes: [],
		},
	],
};

const policy: PostgresPrivacyPolicy = {
	sensitiveColumns: [],
	allowedSensitiveViews: ["analytics.masked_users"],
	safeFunctions: [],
	minimumCohortSize: 10,
};

describe("PostgreSQL privacy policy", () => {
	test("denies direct and wildcard sensitive reads", () => {
		expect(
			evaluatePostgresPrivacyPolicy({
				sql: "SELECT email FROM users",
				schema,
				policy,
			}).safe,
		).toBe(false);
		expect(
			evaluatePostgresPrivacyPolicy({
				sql: "SELECT * FROM users",
				schema,
				policy,
			}).safe,
		).toBe(false);
	});

	test("allows approved views and cohort-protected sensitive aggregates", () => {
		expect(
			evaluatePostgresPrivacyPolicy({
				sql: "SELECT email FROM analytics.masked_users",
				schema,
				policy,
			}).safe,
		).toBe(true);
		expect(
			evaluatePostgresPrivacyPolicy({
				sql: "SELECT count(email) FROM users HAVING count(*) >= 10",
				schema,
				policy,
			}).safe,
		).toBe(true);
	});

	test("rejects cohort bypasses and raw grouping keys", () => {
		expect(
			evaluatePostgresPrivacyPolicy({
				sql: "SELECT count(email) FROM users HAVING count(*) >= 9",
				schema,
				policy,
			}).safe,
		).toBe(false);
		expect(
			evaluatePostgresPrivacyPolicy({
				sql: "SELECT email, count(*) FROM users GROUP BY email HAVING count(*) >= 10",
				schema,
				policy,
			}).safe,
		).toBe(false);
	});

	test("allowlists functions and rejects unsafe clauses", () => {
		expect(
			evaluatePostgresPrivacyPolicy({
				sql: "SELECT lower(display_name) FROM users",
				schema,
				policy,
			}).safe,
		).toBe(true);
		for (const sql of [
			"SELECT pg_read_file('/etc/passwd')",
			"SELECT pg_sleep(10)",
			"SELECT * FROM users FOR UPDATE",
			"EXPLAIN (ANALYZE true) SELECT id FROM users",
		]) {
			expect(evaluatePostgresPrivacyPolicy({ sql, schema, policy }).safe).toBe(
				false,
			);
		}
	});

	test("allows explicitly configured functions", () => {
		expect(
			evaluatePostgresPrivacyPolicy({
				sql: "SELECT analytics.safe_bucket(id) FROM users",
				schema,
				policy: { ...policy, safeFunctions: ["analytics.safe_bucket"] },
			}).safe,
		).toBe(true);
	});
});

function column(name: string) {
	return { name, type: "text", nullable: false, isPrimaryKey: name === "id" };
}
