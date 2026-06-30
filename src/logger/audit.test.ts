import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AuditRecord,
	resolveAuditActor,
	writeAuditEvent,
} from "./audit.js";

describe("audit logger", () => {
	test("writes chained audit events under the configured logs directory", async () => {
		const logsDir = mkdtempSync(join(tmpdir(), "qcp-audit-"));
		const actor = resolveAuditActor("install-1");

		const first = await writeAuditEvent(
			{
				scope: "data_access",
				action: "READ",
				actor,
				resource: {
					command: "ask",
					connectionName: "prod",
					databaseName: "app",
					statementType: "select",
					tables: ["public.projects"],
				},
				delta: null,
				outcome: "success",
				metadata: {
					rowCount: 1,
				},
			},
			{ logsDir, now: () => new Date("2026-06-30T00:00:00.123Z") },
		);
		const second = await writeAuditEvent(
			{
				scope: "data_access",
				action: "EXPLAIN",
				actor,
				resource: {
					command: "ask",
					connectionName: "prod",
					databaseName: "app",
					statementType: "explain",
					tables: ["public.projects"],
				},
				delta: null,
				outcome: "success",
				metadata: {
					estimatedRows: 10,
				},
			},
			{ logsDir, now: () => new Date("2026-06-30T00:00:01.123Z") },
		);

		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);

		const records = readAuditRecords(logsDir);
		const manifest = JSON.parse(
			readFileSync(join(logsDir, "audit-manifest.json"), "utf-8"),
		) as { eventCount: number; latestHash: string };
		expect(records).toHaveLength(2);
		expect(manifest.eventCount).toBe(2);
		expect(manifest.latestHash).toBe(records[1]?.eventHash);
		expect(records[0]?.timestamp).toBe("2026-06-30T00:00:00.123Z");
		expect(records[0]?.actor.userId).toContain("@");
		expect(records[0]?.action).toBe("READ");
		expect(records[0]?.resource.connectionName).toBe("prod");
		expect(records[0]?.delta).toBeNull();
		expect(records[0]?.previousHash).toBeNull();
		expect(records[1]?.previousHash).toBe(records[0]?.eventHash);
	});

	test("redacts database URLs and API keys from audit payloads", async () => {
		const logsDir = mkdtempSync(join(tmpdir(), "qcp-audit-"));
		const result = await writeAuditEvent(
			{
				scope: "auth",
				action: "CONFIG_CHANGE",
				actor: resolveAuditActor("install-1"),
				resource: {
					command: "auth",
				},
				delta: null,
				outcome: "success",
				metadata: {
					error:
						"DATABASE_URL=postgres://readonly:secret@example.com:5432/app api_key=supersecretvalue",
				},
			},
			{ logsDir },
		);

		expect(result.ok).toBe(true);
		const content = readFileSync(join(logsDir, "audit.jsonl"), "utf-8");
		expect(content).not.toContain("postgres://readonly");
		expect(content).not.toContain("supersecretvalue");
		expect(content).not.toContain("$1=");
		expect(content).toContain("DATABASE_URL=[REDACTED_DATABASE_URL]");
		expect(content).toContain("[REDACTED_DATABASE_URL]");
		expect(content).toContain("[REDACTED_SECRET]");
	});

	test("fails audit writes and appends an integrity marker when manifest is mismatched", async () => {
		const logsDir = mkdtempSync(join(tmpdir(), "qcp-audit-"));
		const actor = resolveAuditActor("install-1");
		const first = await writeAuditEvent(
			{
				scope: "data_access",
				action: "READ",
				actor,
				resource: {
					command: "ask",
				},
				delta: null,
				outcome: "success",
			},
			{ logsDir },
		);
		expect(first.ok).toBe(true);

		writeFileSync(
			join(logsDir, "audit-manifest.json"),
			`${JSON.stringify({
				version: 1,
				latestHash: "tampered",
				eventCount: 1,
				updatedAt: "2026-06-30T00:00:00.000Z",
			})}\n`,
			"utf-8",
		);

		const second = await writeAuditEvent(
			{
				scope: "data_access",
				action: "READ",
				actor,
				resource: {
					command: "ask",
				},
				delta: null,
				outcome: "success",
			},
			{ logsDir },
		);

		expect(second.ok).toBe(false);
		const records = readAuditRecords(logsDir);
		expect(records.at(-1)?.action).toBe("AUDIT_INTEGRITY_FAILURE");
		expect(records.at(-1)?.outcome).toBe("failure");
	});
});

function readAuditRecords(logsDir: string): AuditRecord[] {
	return readFileSync(join(logsDir, "audit.jsonl"), "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as AuditRecord);
}
