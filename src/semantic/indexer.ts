import { createHash } from "node:crypto";
import type {
	ActiveDatabaseConnection,
	DatabaseSchema,
	SchemaColumn,
	SchemaForeignKey,
	SchemaTable,
} from "@/types/index.js";
import type { SemanticStore } from "./store.js";
import type {
	SemanticSyncReport,
	UpsertSemanticObjectInput,
	UpsertSemanticRelationshipInput,
} from "./types.js";

export class SemanticSchemaIndexer {
	private readonly store: SemanticStore;

	public constructor(store: SemanticStore) {
		this.store = store;
	}

	public async sync(
		connection: ActiveDatabaseConnection,
		schema: DatabaseSchema,
	): Promise<SemanticSyncReport> {
		const objects = buildSemanticObjects(connection.id, schema);
		const upsert = await this.store.upsertObjects(objects);
		const inactiveObjects = await this.store.markInactiveMissingObjects(
			connection.id,
			objects.map((object) => object.id),
		);
		const relationships = buildForeignKeyRelationships(connection.id, schema);
		const syncedRelationships = await this.store.replaceForeignKeyRelationships(
			connection.id,
			relationships,
		);
		const coverage = await this.store.getCoverageReport(connection.id);

		return {
			connectionId: connection.id,
			syncedObjects: objects.length,
			syncedRelationships,
			staleObjects: coverage.staleObjects,
			inactiveObjects,
			changedObjects: upsert.changed,
		};
	}
}

export function buildSemanticObjects(
	connectionId: string,
	schema: DatabaseSchema,
): UpsertSemanticObjectInput[] {
	const objects: UpsertSemanticObjectInput[] = [];

	for (const table of schema.tables) {
		objects.push({
			id: semanticObjectId({
				connectionId,
				objectType: "table",
				schemaName: table.schema,
				tableName: table.name,
			}),
			connectionId,
			objectType: "table",
			schemaName: table.schema,
			tableName: table.name,
			structuralHash: structuralHashForTable(table),
		});

		for (const column of table.columns) {
			objects.push({
				id: semanticObjectId({
					connectionId,
					objectType: "column",
					schemaName: table.schema,
					tableName: table.name,
					columnName: column.name,
				}),
				connectionId,
				objectType: "column",
				schemaName: table.schema,
				tableName: table.name,
				columnName: column.name,
				dataType: column.type,
				structuralHash: structuralHashForColumn(column),
			});
		}
	}

	return objects;
}

export function buildForeignKeyRelationships(
	connectionId: string,
	schema: DatabaseSchema,
): UpsertSemanticRelationshipInput[] {
	const relationships: UpsertSemanticRelationshipInput[] = [];
	const tableKeys = new Set(
		schema.tables.map((table) => qualifiedTableKey(table.schema, table.name)),
	);

	for (const table of schema.tables) {
		for (const foreignKey of table.foreignKeys) {
			const referencedKey = qualifiedTableKey(
				foreignKey.referencedSchema,
				foreignKey.referencedTable,
			);
			if (!tableKeys.has(referencedKey)) continue;

			const sourceObjectId = semanticObjectId({
				connectionId,
				objectType: "column",
				schemaName: table.schema,
				tableName: table.name,
				columnName: foreignKey.column,
			});
			const targetObjectId = semanticObjectId({
				connectionId,
				objectType: "column",
				schemaName: foreignKey.referencedSchema,
				tableName: foreignKey.referencedTable,
				columnName: foreignKey.referencedColumn,
			});

			relationships.push({
				id: semanticRelationshipId({
					connectionId,
					relationshipType: "foreign_key",
					sourceObjectId,
					targetObjectId,
					constraintName: foreignKey.constraintName,
				}),
				connectionId,
				sourceObjectId,
				targetObjectId,
				relationshipType: "foreign_key",
				constraintName: foreignKey.constraintName,
				description: formatForeignKeyDescription(table, foreignKey),
			});
		}
	}

	return relationships.sort((a, b) => a.id.localeCompare(b.id));
}

export function semanticObjectId(input: {
	readonly connectionId: string;
	readonly objectType: "table" | "column";
	readonly schemaName: string;
	readonly tableName: string;
	readonly columnName?: string;
}): string {
	return stableId("obj", {
		connectionId: input.connectionId,
		objectType: input.objectType,
		schemaName: input.schemaName,
		tableName: input.tableName,
		columnName: input.columnName ?? null,
	});
}

function semanticRelationshipId(input: {
	readonly connectionId: string;
	readonly relationshipType: "foreign_key" | "implicit";
	readonly sourceObjectId: string;
	readonly targetObjectId: string;
	readonly constraintName?: string;
}): string {
	return stableId("rel", {
		connectionId: input.connectionId,
		relationshipType: input.relationshipType,
		sourceObjectId: input.sourceObjectId,
		targetObjectId: input.targetObjectId,
		constraintName: input.constraintName ?? null,
	});
}

function structuralHashForTable(table: SchemaTable): string {
	return stableSha256({
		schema: table.schema,
		name: table.name,
		primaryKeys: [...table.primaryKeys].sort(),
		columns: table.columns.map((column) => ({
			name: column.name,
			type: column.type,
			nullable: column.nullable,
			isPrimaryKey: column.isPrimaryKey,
		})),
		foreignKeys: table.foreignKeys.map((foreignKey) => ({
			constraintName: foreignKey.constraintName,
			column: foreignKey.column,
			referencedSchema: foreignKey.referencedSchema,
			referencedTable: foreignKey.referencedTable,
			referencedColumn: foreignKey.referencedColumn,
		})),
		indexes: table.indexes.map((index) => ({
			name: index.name,
			columns: index.columns,
			unique: index.unique,
			primary: index.primary,
		})),
	});
}

function structuralHashForColumn(column: SchemaColumn): string {
	return stableSha256({
		name: column.name,
		type: column.type,
		nullable: column.nullable,
		defaultValue: column.defaultValue ?? null,
		isPrimaryKey: column.isPrimaryKey,
	});
}

function stableId(prefix: string, value: unknown): string {
	return `${prefix}_${stableSha256(value).slice(0, 32)}`;
}

function stableSha256(value: unknown): string {
	return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
			.join(",")}}`;
	}
	return "null";
}

function qualifiedTableKey(schemaName: string, tableName: string): string {
	return `${schemaName}.${tableName}`;
}

function formatForeignKeyDescription(
	table: SchemaTable,
	foreignKey: SchemaForeignKey,
): string {
	const source = formatQualifiedColumn(
		table.schema,
		table.name,
		foreignKey.column,
	);
	const target = formatQualifiedColumn(
		foreignKey.referencedSchema,
		foreignKey.referencedTable,
		foreignKey.referencedColumn,
	);
	return `${source} references ${target}`;
}

function formatQualifiedColumn(
	schemaName: string,
	tableName: string,
	columnName: string,
): string {
	const tableId =
		schemaName === "public" ? tableName : `${schemaName}.${tableName}`;
	return `${tableId}.${columnName}`;
}
