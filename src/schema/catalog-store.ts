import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ensureLocalDir, LOCAL_SCHEMA_PATH } from "@/config/index.js";
import type {
	ActiveDatabaseConnection,
	DatabaseSchema,
	SchemaCatalog,
	SchemaCatalogEntry,
} from "@/types/index.js";

export interface SchemaCatalogStoreOptions {
	readonly catalogPath: string;
	readonly legacySchemaPath?: string;
}

export class SchemaCatalogStore {
	private readonly catalogPath: string;
	private readonly legacySchemaPath: string;

	public constructor(options: SchemaCatalogStoreOptions) {
		this.catalogPath = options.catalogPath;
		this.legacySchemaPath = options.legacySchemaPath ?? LOCAL_SCHEMA_PATH;
	}

	public load(): SchemaCatalog {
		if (!existsSync(this.catalogPath)) {
			return { version: "1", schemas: [] };
		}

		const raw = readFileSync(this.catalogPath, "utf-8");
		return JSON.parse(raw) as SchemaCatalog;
	}

	public save(catalog: SchemaCatalog): void {
		ensureLocalDir();
		writeFileSync(this.catalogPath, JSON.stringify(catalog, null, 2));
	}

	public upsert(
		connection: ActiveDatabaseConnection,
		schema: DatabaseSchema,
	): SchemaCatalogEntry {
		const catalog = this.load();
		const entry: SchemaCatalogEntry = {
			connectionId: connection.id,
			connectionName: connection.name,
			databaseType: connection.databaseType,
			databaseName: schema.databaseName,
			scannedAt: schema.scannedAt,
			schema,
		};

		const next: SchemaCatalog = {
			version: catalog.version,
			schemas: [
				...catalog.schemas.filter(
					(item) => item.connectionId !== connection.id,
				),
				entry,
			].sort((a, b) => a.connectionName.localeCompare(b.connectionName)),
		};
		this.save(next);
		return entry;
	}

	public get(connectionId: string): SchemaCatalogEntry | undefined {
		return this.load().schemas.find(
			(entry) => entry.connectionId === connectionId,
		);
	}

	public list(): SchemaCatalogEntry[] {
		return [...this.load().schemas].sort((a, b) =>
			a.connectionName.localeCompare(b.connectionName),
		);
	}

	public remove(connectionId: string): void {
		const catalog = this.load();
		this.save({
			version: catalog.version,
			schemas: catalog.schemas.filter(
				(entry) => entry.connectionId !== connectionId,
			),
		});
	}

	public migrateLegacyIfNeeded(
		connection: ActiveDatabaseConnection | undefined,
	): SchemaCatalogEntry | undefined {
		if (!connection || existsSync(this.catalogPath)) return undefined;
		if (!existsSync(this.legacySchemaPath)) return undefined;

		const raw = readFileSync(this.legacySchemaPath, "utf-8");
		const schema = JSON.parse(raw) as DatabaseSchema;
		return this.upsert(connection, schema);
	}
}
