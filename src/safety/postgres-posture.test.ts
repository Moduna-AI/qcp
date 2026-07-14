import { describe, expect, test } from "bun:test";
import { auditPostgresPrivacyPosture } from "./postgres-posture.js";

describe("PostgreSQL privacy posture audit", () => {
	test("reports superuser, BYPASSRLS, and table posture without DDL", async () => {
		let sql = "";
		const report = await auditPostgresPrivacyPosture({
			databaseUrl: "postgres://example.invalid/app",
			schema: {
				scannedAt: "2026-07-12T00:00:00.000Z",
				databaseName: "app",
				tableCount: 1,
				tables: [
					{
						schema: "public",
						name: "users",
						columns: [
							{
								name: "id",
								type: "integer",
								nullable: false,
								isPrimaryKey: true,
							},
							{
								name: "email",
								type: "text",
								nullable: false,
								isPrimaryKey: false,
							},
						],
						primaryKeys: ["id"],
						foreignKeys: [],
						indexes: [],
					},
				],
			},
			queryExecutor: async (_url, query) => {
				sql = query;
				return {
					rows: [
						{
							role_name: "qcp",
							rolsuper: true,
							rolbypassrls: true,
							relations: [
								{
									schema: "public",
									table: "users",
									kind: "r",
									owner: "qcp",
									rls: false,
									forceRls: false,
									selectableColumns: ["id", "email"],
								},
							],
						},
					],
					rowCount: 1,
					fields: [],
					executionTimeMs: 1,
				};
			},
		});
		expect(
			report.findings.filter((finding) => finding.severity === "critical"),
		).toHaveLength(3);
		expect(
			report.findings.some((finding) => finding.detail.includes("users")),
		).toBe(true);
		expect(sql).toContain("pg_roles");
		expect(sql).not.toMatch(/\b(?:ALTER|CREATE|GRANT|REVOKE)\b/i);
	});
});
