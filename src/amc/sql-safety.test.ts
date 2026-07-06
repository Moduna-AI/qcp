import { describe, expect, test } from "bun:test";
import { validateAmazonMarketingCloudSql } from "./sql-safety.js";

describe("Amazon Marketing Cloud SQL safety", () => {
	test("accepts single read-only SELECT and WITH queries", () => {
		expect(
			validateAmazonMarketingCloudSql("SELECT campaign_id FROM impressions"),
		).toMatchObject({
			ok: true,
			sql: "SELECT campaign_id FROM impressions",
		});
		expect(
			validateAmazonMarketingCloudSql(
				"WITH base AS (SELECT user_id FROM conversions) SELECT count(*) FROM base;",
			),
		).toMatchObject({
			ok: true,
			sql: "WITH base AS (SELECT user_id FROM conversions) SELECT count(*) FROM base",
		});
	});

	test("does not treat quoted text as executable SQL", () => {
		expect(
			validateAmazonMarketingCloudSql(
				"SELECT ';' AS separator, 'delete' AS label, \"update\" FROM impressions;",
			),
		).toMatchObject({
			ok: true,
			sql: "SELECT ';' AS separator, 'delete' AS label, \"update\" FROM impressions",
		});
	});

	test("rejects comments, multiple statements, and write/admin keywords", () => {
		expect(
			validateAmazonMarketingCloudSql(
				"SELECT * FROM impressions; DELETE FROM impressions",
			).ok,
		).toBe(false);
		expect(
			validateAmazonMarketingCloudSql("SELECT * FROM impressions -- hidden").ok,
		).toBe(false);
		expect(validateAmazonMarketingCloudSql("CALL some_proc()").ok).toBe(false);
		expect(
			validateAmazonMarketingCloudSql("CREATE TABLE x AS SELECT 1").ok,
		).toBe(false);
	});
});
