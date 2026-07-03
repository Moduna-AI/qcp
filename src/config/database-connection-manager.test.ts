import { describe, expect, test } from "bun:test";
import type {
	AuditEventInput,
	AuditWriteResult,
} from "@/logger/audit.js";
import type {
	ActiveDatabaseConnection,
	DatabaseConnectionConfig,
	DatabaseSchema,
	QcpConfig,
} from "@/types/index.js";
import {
	DatabaseConnectionManager,
	type DatabaseConnectionManagerDependencies,
	type DatabaseConnectionManagerResult,
} from "./database-connection-manager.js";
import { createDefaultConfig, parseQcpConfig } from "./index.js";

const schema: DatabaseSchema = {
	scannedAt: "2026-07-03T00:00:00.000Z",
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

describe("DatabaseConnectionManager", () => {
	test("adds a verified connection and indexes schema", async () => {
		const harness = createHarness(createDefaultConfig());
		const manager = new DatabaseConnectionManager(harness.dependencies);

		const result = await manager.add({
			name: "prod",
			databaseType: "other-postgres",
			databaseUrl: "postgres://prod/app",
		});

		assertAddEditSuccess(result);
		expect(result.operation).toBe("add");
		expect(result.connection.name).toBe("prod");
		expect(harness.saveCalls).toHaveLength(1);
		expect(harness.savedSchemas[0]?.connection.name).toBe("prod");
		expect(harness.auditEvents[0]?.outcome).toBe("success");
	});

	test("does not save or scan when connection testing fails", async () => {
		const harness = createHarness(createConfigWithConnections([]), {
			testResult: {
				connected: false,
				version: "",
				readOnly: false,
				error: "password authentication failed",
			},
		});
		const manager = new DatabaseConnectionManager(harness.dependencies);

		const result = await manager.add({
			name: "prod",
			databaseType: "other-postgres",
			databaseUrl: "postgres://prod/app",
		});

		expect(result).toEqual({
			ok: false,
			operation: "add",
			error: "password authentication failed",
		});
		expect(harness.saveCalls).toHaveLength(0);
		expect(harness.savedSchemas).toHaveLength(0);
		expect(harness.auditEvents[0]?.outcome).toBe("failure");
	});

	test("edits a connection and removes stale schema when scan fails", async () => {
		const harness = createHarness(
			createConfigWithConnections([
				connectionConfig("prod", "other-postgres", "postgres://prod/app"),
			]),
			{ schemaError: "permission denied for schema private" },
		);
		const manager = new DatabaseConnectionManager(harness.dependencies);

		const result = await manager.edit({
			alias: "prod",
			name: "production",
			databaseType: "neon",
			databaseUrl: "postgres://production/app",
		});

		assertAddEditSuccess(result);
		expect(result.operation).toBe("edit");
		expect(result.connection.name).toBe("production");
		expect(result.schema).toEqual({
			status: "failed",
			error: "permission denied for schema private",
		});
		expect(harness.removedSchemaIds).toEqual(["prod"]);
		expect(harness.currentConfig.databaseConnections[0]?.name).toBe(
			"production",
		);
		expect(harness.auditEvents[0]?.outcome).toBe("success");
	});

	test("removes a connection and its schema cache", async () => {
		const harness = createHarness(
			createConfigWithConnections([
				connectionConfig("zeta", "other-postgres", "postgres://zeta/app"),
				connectionConfig("prod", "other-postgres", "postgres://prod/app"),
				connectionConfig("alpha", "other-postgres", "postgres://alpha/app"),
			], "prod"),
		);
		const manager = new DatabaseConnectionManager(harness.dependencies);

		const result = await manager.remove({ alias: "prod" });

		assertRemoveSuccess(result);
		expect(result.removedConnection.name).toBe("prod");
		expect(result.activeDatabaseId).toBe("alpha");
		expect(harness.removedSchemaIds).toEqual(["prod"]);
		expect(harness.currentConfig.databaseConnections.map((item) => item.name)).toEqual(
			["alpha", "zeta"],
		);
		expect(harness.auditEvents[0]?.outcome).toBe("success");
	});

	test("audits remove failures", async () => {
		const harness = createHarness(createConfigWithConnections([]));
		const manager = new DatabaseConnectionManager(harness.dependencies);

		const result = await manager.remove({ alias: "missing" });

		expect(result.ok).toBe(false);
		expect(harness.saveCalls).toHaveLength(0);
		expect(harness.auditEvents[0]?.outcome).toBe("failure");
	});
});

function createHarness(
	initialConfig: QcpConfig,
	options: {
		readonly testResult?: {
			readonly connected: boolean;
			readonly version: string;
			readonly readOnly: boolean;
			readonly error?: string;
		};
		readonly schemaError?: string;
	} = {},
): {
	readonly dependencies: DatabaseConnectionManagerDependencies;
	readonly saveCalls: Partial<QcpConfig>[];
	readonly savedSchemas: {
		readonly connection: ActiveDatabaseConnection;
		readonly schema: DatabaseSchema;
	}[];
	readonly removedSchemaIds: string[];
	readonly auditEvents: AuditEventInput[];
	readonly currentConfig: QcpConfig;
} {
	let currentConfig = initialConfig;
	const saveCalls: Partial<QcpConfig>[] = [];
	const savedSchemas: {
		readonly connection: ActiveDatabaseConnection;
		readonly schema: DatabaseSchema;
	}[] = [];
	const removedSchemaIds: string[] = [];
	const auditEvents: AuditEventInput[] = [];

	return {
		get currentConfig() {
			return currentConfig;
		},
		saveCalls,
		savedSchemas,
		removedSchemaIds,
		auditEvents,
		dependencies: {
			loadConfig: () => currentConfig,
			saveConfig: (config) => {
				saveCalls.push(config);
				currentConfig = parseQcpConfig({ ...currentConfig, ...config });
				return currentConfig;
			},
			testConnection: async () =>
				options.testResult ?? {
					connected: true,
					version: "PostgreSQL 16.1",
					readOnly: true,
				},
			checkReadOnlyUser: async () => true,
			scanSchema: async () => {
				if (options.schemaError) {
					throw new Error(options.schemaError);
				}
				return schema;
			},
			saveSchemaForConnection: (connection, nextSchema) => {
				savedSchemas.push({ connection, schema: nextSchema });
			},
			removeSchemaForConnection: (connectionId) => {
				removedSchemaIds.push(connectionId);
			},
			writeAuditEvent: async (input): Promise<AuditWriteResult> => {
				auditEvents.push(input);
				return { ok: false, error: "audit disabled in test" };
			},
		},
	};
}

function createConfigWithConnections(
	connections: DatabaseConnectionConfig[],
	activeDatabaseId = connections[0]?.id,
): QcpConfig {
	return parseQcpConfig({
		databaseConnections: connections,
		activeDatabaseId,
	});
}

function connectionConfig(
	name: string,
	databaseType: QcpConfig["databaseType"],
	databaseUrl: string,
): DatabaseConnectionConfig {
	return {
		id: name,
		name,
		databaseType,
		databaseUrl,
		createdAt: "2026-07-03T00:00:00.000Z",
		updatedAt: "2026-07-03T00:00:00.000Z",
	};
}

function assertAddEditSuccess(
	result: DatabaseConnectionManagerResult,
): asserts result is Extract<
	DatabaseConnectionManagerResult,
	{ readonly ok: true; readonly operation: "add" | "edit" }
> {
	expect(result.ok).toBe(true);
	if (!result.ok || result.operation === "remove") {
		throw new Error("Expected add/edit success");
	}
}

function assertRemoveSuccess(
	result: DatabaseConnectionManagerResult,
): asserts result is Extract<
	DatabaseConnectionManagerResult,
	{ readonly ok: true; readonly operation: "remove" }
> {
	expect(result.ok).toBe(true);
	if (!result.ok || result.operation !== "remove") {
		throw new Error("Expected remove success");
	}
}
