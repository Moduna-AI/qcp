import {
	checkReadOnlyUser,
	testConnection,
} from "@/db/index.js";
import {
	buildAuditResource,
	resolveAuditActor,
	writeAuditEvent,
} from "@/logger/audit.js";
import {
	removeSchemaForConnection,
	saveSchemaForConnection,
	scanSchema,
} from "@/schema/index.js";
import type {
	ActiveDatabaseConnection,
	DatabaseConnectionConfig,
	DatabaseSchema,
	DatabaseType,
	QcpConfig,
} from "@/types/index.js";
import type {
	AuditEventInput,
	AuditWriteResult,
} from "@/logger/audit.js";
import {
	DatabaseConnectionNotFoundError,
	DatabaseConnectionRegistry,
	normalizeDatabaseAlias,
	resolveDatabaseUrlForConnection,
} from "./database-connection-registry.js";
import {
	getActiveDatabaseConnection,
	loadConfig,
	saveConfig,
} from "./index.js";

export interface AddDatabaseConnectionInput {
	readonly name: string;
	readonly databaseType: DatabaseType;
	readonly databaseUrl: string;
	readonly prismaSchemaPath?: string;
	readonly prismaDatasourceName?: string;
}

export interface EditDatabaseConnectionInput {
	readonly alias: string;
	readonly name?: string;
	readonly databaseType?: DatabaseType;
	readonly databaseUrl?: string;
	readonly prismaSchemaPath?: string;
	readonly prismaDatasourceName?: string;
}

export interface RemoveDatabaseConnectionInput {
	readonly alias: string;
}

export type SchemaRefreshResult =
	| {
			readonly status: "updated";
			readonly databaseName: string;
			readonly tableCount: number;
	  }
	| {
			readonly status: "failed";
			readonly error: string;
	  };

export type DatabaseConnectionManagerResult =
	| {
			readonly ok: true;
			readonly operation: "add" | "edit";
			readonly config: QcpConfig;
			readonly connection: ActiveDatabaseConnection;
			readonly databaseVersion: string;
			readonly readOnly: boolean;
			readonly schema: SchemaRefreshResult;
	  }
	| {
			readonly ok: true;
			readonly operation: "remove";
			readonly config: QcpConfig;
			readonly removedConnection: DatabaseConnectionConfig;
			readonly activeDatabaseId?: string;
	  }
	| {
			readonly ok: false;
			readonly operation: "add" | "edit" | "remove";
			readonly error: string;
	  };

interface DatabaseConnectionTestResult {
	readonly connected: boolean;
	readonly version: string;
	readonly readOnly: boolean;
	readonly error?: string;
}

export interface DatabaseConnectionManagerDependencies {
	readonly loadConfig: () => QcpConfig;
	readonly saveConfig: (config: Partial<QcpConfig>) => QcpConfig;
	readonly testConnection: (
		databaseUrl: string,
	) => Promise<DatabaseConnectionTestResult>;
	readonly checkReadOnlyUser: (databaseUrl: string) => Promise<boolean>;
	readonly scanSchema: (databaseUrl: string) => Promise<DatabaseSchema>;
	readonly saveSchemaForConnection: (
		connection: ActiveDatabaseConnection,
		schema: DatabaseSchema,
	) => unknown;
	readonly removeSchemaForConnection: (connectionId: string) => void;
	readonly writeAuditEvent: (
		input: AuditEventInput,
	) => Promise<AuditWriteResult>;
}

export class DatabaseConnectionManager {
	private readonly dependencies: DatabaseConnectionManagerDependencies;

	public constructor(
		dependencies: DatabaseConnectionManagerDependencies = {
			loadConfig,
			saveConfig,
			testConnection,
			checkReadOnlyUser,
			scanSchema,
			saveSchemaForConnection,
			removeSchemaForConnection,
			writeAuditEvent,
		},
	) {
		this.dependencies = dependencies;
	}

	public async add(
		input: AddDatabaseConnectionInput,
	): Promise<DatabaseConnectionManagerResult> {
		return await this.saveVerifiedConnection("add", "connect", input.name, () => {
			const config = this.dependencies.loadConfig();
			const registry = new DatabaseConnectionRegistry(config);
			const snapshot = registry.upsert(
				{
					name: input.name,
					databaseType: input.databaseType,
					databaseUrl: input.databaseUrl,
					prismaSchemaPath:
						input.databaseType === "prisma-postgres"
							? input.prismaSchemaPath
							: undefined,
					prismaDatasourceName:
						input.databaseType === "prisma-postgres"
							? input.prismaDatasourceName
							: undefined,
				},
				{ setActive: true },
			);

			return this.buildPendingConnection(config, snapshot, input.name);
		});
	}

	public async edit(
		input: EditDatabaseConnectionInput,
	): Promise<DatabaseConnectionManagerResult> {
		return await this.saveVerifiedConnection(
			"edit",
			"db edit",
			input.name ?? input.alias,
			() => {
				const config = this.dependencies.loadConfig();
				const registry = new DatabaseConnectionRegistry(config);
				const snapshot = registry.update(input.alias, {
					name: input.name,
					databaseType: input.databaseType,
					databaseUrl: input.databaseUrl,
					prismaSchemaPath: input.prismaSchemaPath,
					prismaDatasourceName: input.prismaDatasourceName,
				});

				return this.buildPendingConnection(
					config,
					snapshot,
					input.name ?? input.alias,
				);
			},
		);
	}

	public async remove(
		input: RemoveDatabaseConnectionInput,
	): Promise<DatabaseConnectionManagerResult> {
		let config: QcpConfig;
		let alias: string;
		let removedConnection: DatabaseConnectionConfig | undefined;

		try {
			config = this.dependencies.loadConfig();
			alias = normalizeDatabaseAlias(input.alias);
			const registry = new DatabaseConnectionRegistry(config);
			removedConnection = registry.findByName(alias);
			if (!removedConnection) {
				throw new DatabaseConnectionNotFoundError(alias);
			}

			const snapshot = registry.remove(alias);
			const savedConfig = this.dependencies.saveConfig({
				...config,
				databaseConnections: snapshot.connections,
				activeDatabaseId: snapshot.activeDatabaseId,
			});
			this.dependencies.removeSchemaForConnection(removedConnection.id);
			await this.auditConnectionEvent(savedConfig, {
				command: "db remove",
				name: removedConnection.name,
				connectionId: removedConnection.id,
				databaseType: removedConnection.databaseType,
				outcome: "success",
			});

			return {
				ok: true,
				operation: "remove",
				config: savedConfig,
				removedConnection,
				activeDatabaseId: savedConfig.activeDatabaseId,
			};
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			const auditConfig = this.dependencies.loadConfig();
			await this.auditConnectionEvent(auditConfig, {
				command: "db remove",
				name: input.alias,
				connectionId: removedConnection?.id,
				databaseType: removedConnection?.databaseType,
				outcome: "failure",
				error: message,
			});
			return { ok: false, operation: "remove", error: message };
		}
	}

	private async saveVerifiedConnection(
		operation: "add" | "edit",
		command: "connect" | "db edit",
		connectionName: string,
		createPending: () => PendingDatabaseConnection,
	): Promise<DatabaseConnectionManagerResult> {
		let pending: PendingDatabaseConnection;
		try {
			pending = createPending();
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			const config = this.dependencies.loadConfig();
			await this.auditConnectionEvent(config, {
				command,
				name: connectionName,
				outcome: "failure",
				error: message,
			});
			return { ok: false, operation, error: message };
		}

		let testResult: DatabaseConnectionTestResult;
		try {
			testResult = await this.dependencies.testConnection(
				pending.connection.databaseUrl,
			);
		} catch (err: unknown) {
			const error = err instanceof Error ? err.message : String(err);
			await this.auditConnectionEvent(pending.config, {
				command,
				name: pending.connection.name,
				connectionId: pending.connection.id,
				databaseType: pending.connection.databaseType,
				outcome: "failure",
				error,
			});
			return { ok: false, operation, error };
		}
		if (!testResult.connected) {
			const error = testResult.error ?? "Unknown connection error";
			await this.auditConnectionEvent(pending.config, {
				command,
				name: pending.connection.name,
				connectionId: pending.connection.id,
				databaseType: pending.connection.databaseType,
				outcome: "failure",
				error,
			});
			return { ok: false, operation, error };
		}

		const savedConfig = this.dependencies.saveConfig({
			...pending.config,
			databaseConnections: pending.connections,
			activeDatabaseId: pending.activeDatabaseId,
		});
		const connection = getActiveDatabaseConnection(
			savedConfig,
			pending.connection.name,
		);
		if (!connection) {
			const error = `Database connection not found after saving: ${pending.connection.name}`;
			await this.auditConnectionEvent(savedConfig, {
				command,
				name: pending.connection.name,
				outcome: "failure",
				error,
			});
			return { ok: false, operation, error };
		}

		const readOnly = await this.checkReadOnly(connection.databaseUrl);
		const schema = await this.refreshSchema(connection);
		await this.auditConnectionEvent(savedConfig, {
			command,
			name: connection.name,
			connectionId: connection.id,
			databaseType: connection.databaseType,
			databaseName:
				schema.status === "updated" ? schema.databaseName : undefined,
			outcome: "success",
			readOnly,
		});

		return {
			ok: true,
			operation,
			config: savedConfig,
			connection,
			databaseVersion: testResult.version,
			readOnly,
			schema,
		};
	}

	private buildPendingConnection(
		config: QcpConfig,
		snapshot: {
			readonly connections: readonly DatabaseConnectionConfig[];
			readonly activeDatabaseId?: string;
		},
		name: string,
	): PendingDatabaseConnection {
		const normalizedName = normalizeDatabaseAlias(name);
		const connection = snapshot.connections.find(
			(item) => item.name === normalizedName,
		);
		if (!connection) {
			throw new DatabaseConnectionNotFoundError(normalizedName);
		}

		return {
			config,
			connections: [...snapshot.connections],
			activeDatabaseId: snapshot.activeDatabaseId,
			connection: {
				id: connection.id,
				name: connection.name,
				databaseType: connection.databaseType,
				databaseUrl: resolveDatabaseUrlForConnection(connection),
				prismaSchemaPath: connection.prismaSchemaPath,
				prismaDatasourceName: connection.prismaDatasourceName,
			},
		};
	}

	private async refreshSchema(
		connection: ActiveDatabaseConnection,
	): Promise<SchemaRefreshResult> {
		try {
			const schema = await this.dependencies.scanSchema(connection.databaseUrl);
			this.dependencies.saveSchemaForConnection(connection, schema);
			return {
				status: "updated",
				databaseName: schema.databaseName,
				tableCount: schema.tableCount,
			};
		} catch (err: unknown) {
			const error = err instanceof Error ? err.message : String(err);
			this.dependencies.removeSchemaForConnection(connection.id);
			return { status: "failed", error };
		}
	}

	private async checkReadOnly(databaseUrl: string): Promise<boolean> {
		try {
			return await this.dependencies.checkReadOnlyUser(databaseUrl);
		} catch {
			return false;
		}
	}

	private async auditConnectionEvent(
		config: QcpConfig,
		event: {
			readonly command: string;
			readonly name: string;
			readonly connectionId?: string;
			readonly databaseType?: DatabaseType;
			readonly outcome: "success" | "failure";
			readonly databaseName?: string;
			readonly readOnly?: boolean;
			readonly error?: string;
		},
	): Promise<void> {
		await this.dependencies.writeAuditEvent({
			scope: "system_admin",
			action: "CONNECTION_CHANGE",
			actor: resolveAuditActor(config.installId),
			resource: buildAuditResource({
				command: event.command,
				installId: config.installId,
				connectionId: event.connectionId,
				connectionName: event.name,
				databaseType: event.databaseType,
				databaseName: event.databaseName,
				provider: config.provider,
				model: config.model,
			}),
			delta: null,
			outcome: event.outcome,
			metadata: {
				readOnly: event.readOnly ?? null,
				error: event.error ?? null,
			},
		});
	}
}

interface PendingDatabaseConnection {
	readonly config: QcpConfig;
	readonly connections: DatabaseConnectionConfig[];
	readonly activeDatabaseId?: string;
	readonly connection: ActiveDatabaseConnection;
}
