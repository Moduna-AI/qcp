import { describe, expect, test } from "bun:test";
import type { SqliteDatabaseImportResult } from "@/transfer/sqlite-database-import.js";
import { createSupervisorTools } from "./supervisor-tools.js";

describe("supervisor tools", () => {
	test("exposes a native-approval SQLite import tool with MCP annotations", async () => {
		const tools = createSupervisorTools({
			databaseType: "supabase",
			databaseUrl: "postgres://unused",
			importer: successfulImporter(),
		});
		const tool = tools.qcp_import_sqlite_database;

		expect(tool).toBeDefined();
		expect(tool?.requireApproval).toBe(true);
		expect(tool?.mcp?.annotations).toEqual({
			title: "Import SQLite Database into Supabase",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});
	});

	test("fails closed when the active connection is not Supabase", async () => {
		let called = false;
		const tools = createSupervisorTools({
			databaseType: "other-postgres",
			databaseUrl: "postgres://unused",
			importer: {
				importDatabase: async () => {
					called = true;
					return successResult();
				},
			},
		});
		const tool = tools.qcp_import_sqlite_database;
		if (!tool?.execute) throw new Error("SQLite import tool is unavailable");

		const output = await tool.execute(
			{ filePath: "fixture.sqlite" },
			undefined as never,
		);

		expect(output).toMatchObject({ ok: false, rolledBack: false });
		expect(called).toBe(false);
	});

	test("passes only the structured file path to the importer", async () => {
		let receivedPath: string | undefined;
		const tools = createSupervisorTools({
			databaseType: "supabase",
			databaseUrl: "postgres://unused",
			importer: {
				importDatabase: async (filePath) => {
					receivedPath = filePath;
					return successResult();
				},
			},
		});
		const tool = tools.qcp_import_sqlite_database;
		if (!tool?.execute) throw new Error("SQLite import tool is unavailable");

		await tool.execute({ filePath: "./fixture.sqlite" }, undefined as never);

		expect(receivedPath).toBe("./fixture.sqlite");
	});
});

function successfulImporter(): {
	importDatabase(filePath: string): Promise<SqliteDatabaseImportResult>;
} {
	return { importDatabase: async () => successResult() };
}

function successResult(): SqliteDatabaseImportResult {
	return {
		ok: true,
		sourcePath: "/workspace/fixture.sqlite",
		targetSchema: "public",
		tableCount: 1,
		totalRowCount: 1,
		tables: [{ sourceTable: "Artist", targetTable: "artist", rowCount: 1 }],
		durationMs: 1,
		schemaRefreshed: true,
	};
}
