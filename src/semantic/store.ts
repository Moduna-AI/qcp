import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { v7 as uuidv7 } from "uuid";
import { LOCAL_SEMANTIC_DB_PATH } from "@/config/index.js";
import { createLocalSqliteClient } from "@/sqlite-client.js";
import type {
	AddSemanticAnnotationInput,
	SemanticAnnotation,
	SemanticCoverageByType,
	SemanticCoverageReport,
	SemanticObject,
	SemanticObjectType,
	SemanticRelationship,
	SemanticValueFrequency,
	SemanticValueProfile,
	UpsertSemanticObjectInput,
	UpsertSemanticRelationshipInput,
	UpsertSemanticValueProfileInput,
} from "./types.js";

export type SemanticSqlValue =
	| string
	| number
	| bigint
	| boolean
	| null
	| Uint8Array;

export interface SemanticSqlResult {
	readonly rows: readonly unknown[];
}

export interface SemanticSqlClient {
	execute(
		statement:
			| string
			| { readonly sql: string; readonly args?: readonly SemanticSqlValue[] },
	): Promise<SemanticSqlResult>;
	close(): void | Promise<void>;
}

export interface SemanticStoreOptions {
	readonly databasePath?: string;
	readonly client?: SemanticSqlClient;
	readonly now?: () => Date;
}

interface SemanticObjectRow {
	readonly id: string;
	readonly connection_id: string;
	readonly object_type: string;
	readonly schema_name: string;
	readonly table_name: string;
	readonly column_name: string | null;
	readonly data_type: string | null;
	readonly structural_hash: string;
	readonly active: number;
	readonly stale: number;
	readonly last_seen_at: string;
	readonly created_at: string;
	readonly updated_at: string;
}

interface SemanticAnnotationRow {
	readonly id: string;
	readonly object_id: string;
	readonly version: number;
	readonly description: string;
	readonly business_name: string | null;
	readonly synonyms_json: string;
	readonly notes: string | null;
	readonly source: string;
	readonly created_at: string;
}

interface SemanticRelationshipRow {
	readonly id: string;
	readonly connection_id: string;
	readonly source_object_id: string;
	readonly target_object_id: string;
	readonly relationship_type: string;
	readonly constraint_name: string | null;
	readonly description: string | null;
	readonly created_at: string;
	readonly updated_at: string;
}

interface SemanticValueProfileRow {
	readonly id: string;
	readonly object_id: string;
	readonly distinct_count: number | null;
	readonly sample_values_json: string;
	readonly top_values_json: string;
	readonly truncated: number;
	readonly profiled_at: string;
}

export class SemanticStoreError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "SemanticStoreError";
	}
}

export class SemanticStore {
	private readonly databasePath: string;
	private readonly providedClient: SemanticSqlClient | undefined;
	private readonly now: () => Date;
	private client: SemanticSqlClient | null;
	private initialized: boolean;

	public constructor(options: SemanticStoreOptions = {}) {
		this.databasePath = options.databasePath ?? LOCAL_SEMANTIC_DB_PATH;
		this.providedClient = options.client;
		this.client = options.client ?? null;
		this.now = options.now ?? (() => new Date());
		this.initialized = false;
	}

	public getPath(): string {
		return this.databasePath;
	}

	public async init(): Promise<void> {
		if (this.initialized) return;
		const client = await this.getClient();

		await client.execute(`
      CREATE TABLE IF NOT EXISTS semantic_objects (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        object_type TEXT NOT NULL CHECK (object_type IN ('table', 'column')),
        schema_name TEXT NOT NULL,
        table_name TEXT NOT NULL,
        column_name TEXT,
        data_type TEXT,
        structural_hash TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        stale INTEGER NOT NULL DEFAULT 0,
        last_seen_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
		await client.execute(`
      CREATE INDEX IF NOT EXISTS idx_semantic_objects_connection
      ON semantic_objects (connection_id, active, object_type)
    `);
		await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_semantic_objects_identity
      ON semantic_objects (
        connection_id,
        object_type,
        schema_name,
        table_name,
        COALESCE(column_name, '')
      )
    `);
		await client.execute(`
      CREATE TABLE IF NOT EXISTS semantic_annotations (
        id TEXT PRIMARY KEY,
        object_id TEXT NOT NULL REFERENCES semantic_objects(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        description TEXT NOT NULL,
        business_name TEXT,
        synonyms_json TEXT NOT NULL DEFAULT '[]',
        notes TEXT,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (object_id, version)
      )
    `);
		await client.execute(`
      CREATE INDEX IF NOT EXISTS idx_semantic_annotations_object
      ON semantic_annotations (object_id, version DESC)
    `);
		await client.execute(`
      CREATE TABLE IF NOT EXISTS semantic_relationships (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        source_object_id TEXT NOT NULL REFERENCES semantic_objects(id) ON DELETE CASCADE,
        target_object_id TEXT NOT NULL REFERENCES semantic_objects(id) ON DELETE CASCADE,
        relationship_type TEXT NOT NULL CHECK (relationship_type IN ('foreign_key', 'implicit')),
        constraint_name TEXT,
        description TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
		await client.execute(`
      CREATE INDEX IF NOT EXISTS idx_semantic_relationships_connection
      ON semantic_relationships (connection_id, relationship_type)
    `);
		await client.execute(`
      CREATE TABLE IF NOT EXISTS semantic_value_profiles (
        id TEXT PRIMARY KEY,
        object_id TEXT NOT NULL UNIQUE REFERENCES semantic_objects(id) ON DELETE CASCADE,
        distinct_count INTEGER,
        sample_values_json TEXT NOT NULL DEFAULT '[]',
        top_values_json TEXT NOT NULL DEFAULT '[]',
        truncated INTEGER NOT NULL DEFAULT 0,
        profiled_at TEXT NOT NULL
      )
    `);

		this.initialized = true;
	}

	public async close(): Promise<void> {
		if (!this.client || this.providedClient) return;
		await this.client.close();
		this.client = null;
		this.initialized = false;
	}

	public async hasConnectionState(connectionId: string): Promise<boolean> {
		await this.init();
		const rows = await this.queryRows(
			"SELECT id FROM semantic_objects WHERE connection_id = ? LIMIT 1",
			[connectionId],
		);
		return rows.length > 0;
	}

	public async upsertObjects(
		objects: readonly UpsertSemanticObjectInput[],
	): Promise<{ readonly changed: number }> {
		await this.init();
		let changed = 0;

		for (const object of objects) {
			const now = this.nowIso();
			const existing = await this.getObjectById(object.id);
			const isChanged =
				existing !== undefined &&
				existing.structuralHash !== object.structuralHash;
			if (isChanged) changed += 1;
			const stale = existing ? existing.stale || isChanged : false;
			const createdAt = existing?.createdAt ?? now;

			await this.execute(
				`
          INSERT INTO semantic_objects (
            id,
            connection_id,
            object_type,
            schema_name,
            table_name,
            column_name,
            data_type,
            structural_hash,
            active,
            stale,
            last_seen_at,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            connection_id = excluded.connection_id,
            object_type = excluded.object_type,
            schema_name = excluded.schema_name,
            table_name = excluded.table_name,
            column_name = excluded.column_name,
            data_type = excluded.data_type,
            structural_hash = excluded.structural_hash,
            active = 1,
            stale = excluded.stale,
            last_seen_at = excluded.last_seen_at,
            updated_at = excluded.updated_at
        `,
				[
					object.id,
					object.connectionId,
					object.objectType,
					object.schemaName,
					object.tableName,
					object.columnName ?? null,
					object.dataType ?? null,
					object.structuralHash,
					stale ? 1 : 0,
					now,
					createdAt,
					now,
				],
			);
		}

		return { changed };
	}

	public async markInactiveMissingObjects(
		connectionId: string,
		activeObjectIds: readonly string[],
	): Promise<number> {
		await this.init();
		const active = new Set(activeObjectIds);
		const existing = await this.listObjects({ connectionId });
		let inactive = 0;

		for (const object of existing) {
			if (active.has(object.id)) continue;
			await this.execute(
				`
          UPDATE semantic_objects
          SET active = 0, stale = 1, updated_at = ?
          WHERE id = ?
        `,
				[this.nowIso(), object.id],
			);
			inactive += 1;
		}

		return inactive;
	}

	public async addAnnotation(
		input: AddSemanticAnnotationInput,
	): Promise<SemanticAnnotation> {
		await this.init();
		const description = input.description.trim();
		if (!description) {
			throw new SemanticStoreError(
				"Semantic annotation description is required.",
			);
		}

		const nextVersion = await this.nextAnnotationVersion(input.objectId);
		const annotation: SemanticAnnotation = {
			id: uuidv7(),
			objectId: input.objectId,
			version: nextVersion,
			description,
			businessName: normalizeOptionalString(input.businessName),
			synonyms: normalizeSynonyms(input.synonyms ?? []),
			notes: normalizeOptionalString(input.notes),
			source: input.source,
			createdAt: this.nowIso(),
		};

		await this.execute(
			`
        INSERT INTO semantic_annotations (
          id,
          object_id,
          version,
          description,
          business_name,
          synonyms_json,
          notes,
          source,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
			[
				annotation.id,
				annotation.objectId,
				annotation.version,
				annotation.description,
				annotation.businessName ?? null,
				JSON.stringify(annotation.synonyms),
				annotation.notes ?? null,
				annotation.source,
				annotation.createdAt,
			],
		);
		await this.execute(
			"UPDATE semantic_objects SET stale = 0, updated_at = ? WHERE id = ?",
			[annotation.createdAt, annotation.objectId],
		);

		return annotation;
	}

	public async getObjectById(
		objectId: string,
	): Promise<SemanticObject | undefined> {
		await this.init();
		const rows = await this.queryRows(
			"SELECT * FROM semantic_objects WHERE id = ?",
			[objectId],
		);
		const row = rows[0];
		return row ? semanticObjectFromRow(row) : undefined;
	}

	public async getObjectsByIds(
		objectIds: readonly string[],
	): Promise<SemanticObject[]> {
		await this.init();
		const objects: SemanticObject[] = [];
		for (const objectId of objectIds) {
			const object = await this.getObjectById(objectId);
			if (object) objects.push(object);
		}
		return objects;
	}

	public async listObjects(options: {
		readonly connectionId: string;
		readonly activeOnly?: boolean;
		readonly objectType?: SemanticObjectType;
	}): Promise<SemanticObject[]> {
		await this.init();
		const filters = ["connection_id = ?"];
		const args: SemanticSqlValue[] = [options.connectionId];
		if (options.activeOnly) filters.push("active = 1");
		if (options.objectType) {
			filters.push("object_type = ?");
			args.push(options.objectType);
		}

		const rows = await this.queryRows(
			`
        SELECT *
        FROM semantic_objects
        WHERE ${filters.join(" AND ")}
        ORDER BY schema_name, table_name, COALESCE(column_name, '')
      `,
			args,
		);
		return rows.map(semanticObjectFromRow);
	}

	public async listLatestAnnotations(
		connectionId: string,
	): Promise<SemanticAnnotation[]> {
		await this.init();
		const rows = await this.queryRows(
			`
        SELECT a.*
        FROM semantic_annotations a
        JOIN semantic_objects o ON o.id = a.object_id
        WHERE o.connection_id = ?
        ORDER BY a.object_id, a.version DESC
      `,
			[connectionId],
		);

		const seen = new Set<string>();
		const annotations: SemanticAnnotation[] = [];
		for (const row of rows) {
			const annotation = semanticAnnotationFromRow(row);
			if (seen.has(annotation.objectId)) continue;
			seen.add(annotation.objectId);
			annotations.push(annotation);
		}

		return annotations;
	}

	public async getLatestAnnotationMap(
		connectionId: string,
	): Promise<Map<string, SemanticAnnotation>> {
		const annotations = await this.listLatestAnnotations(connectionId);
		return new Map(
			annotations.map((annotation) => [annotation.objectId, annotation]),
		);
	}

	public async listAnnotationsForObject(
		objectId: string,
	): Promise<SemanticAnnotation[]> {
		await this.init();
		const rows = await this.queryRows(
			`
        SELECT *
        FROM semantic_annotations
        WHERE object_id = ?
        ORDER BY version ASC
      `,
			[objectId],
		);
		return rows.map(semanticAnnotationFromRow);
	}

	public async replaceForeignKeyRelationships(
		connectionId: string,
		relationships: readonly UpsertSemanticRelationshipInput[],
	): Promise<number> {
		await this.init();
		await this.execute(
			`
        DELETE FROM semantic_relationships
        WHERE connection_id = ? AND relationship_type = 'foreign_key'
      `,
			[connectionId],
		);

		for (const relationship of relationships) {
			await this.upsertRelationship(relationship);
		}

		return relationships.length;
	}

	public async upsertRelationship(
		relationship: UpsertSemanticRelationshipInput,
	): Promise<SemanticRelationship> {
		await this.init();
		const existing = await this.getRelationshipById(relationship.id);
		const now = this.nowIso();
		const createdAt = existing?.createdAt ?? now;

		await this.execute(
			`
        INSERT INTO semantic_relationships (
          id,
          connection_id,
          source_object_id,
          target_object_id,
          relationship_type,
          constraint_name,
          description,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          connection_id = excluded.connection_id,
          source_object_id = excluded.source_object_id,
          target_object_id = excluded.target_object_id,
          relationship_type = excluded.relationship_type,
          constraint_name = excluded.constraint_name,
          description = excluded.description,
          updated_at = excluded.updated_at
      `,
			[
				relationship.id,
				relationship.connectionId,
				relationship.sourceObjectId,
				relationship.targetObjectId,
				relationship.relationshipType,
				relationship.constraintName ?? null,
				relationship.description ?? null,
				createdAt,
				now,
			],
		);

		const saved = await this.getRelationshipById(relationship.id);
		if (!saved) {
			throw new SemanticStoreError("Semantic relationship was not saved.");
		}
		return saved;
	}

	public async listRelationships(
		connectionId: string,
	): Promise<SemanticRelationship[]> {
		await this.init();
		const rows = await this.queryRows(
			`
        SELECT *
        FROM semantic_relationships
        WHERE connection_id = ?
        ORDER BY relationship_type, constraint_name, id
      `,
			[connectionId],
		);
		return rows.map(semanticRelationshipFromRow);
	}

	public async upsertValueProfile(
		input: UpsertSemanticValueProfileInput,
	): Promise<SemanticValueProfile> {
		await this.init();
		const existing = await this.getValueProfile(input.objectId);
		const profile: SemanticValueProfile = {
			id: existing?.id ?? uuidv7(),
			objectId: input.objectId,
			distinctCount: input.distinctCount,
			sampleValues: input.sampleValues,
			topValues: input.topValues,
			truncated: input.truncated,
			profiledAt: this.nowIso(),
		};

		await this.execute(
			`
        INSERT INTO semantic_value_profiles (
          id,
          object_id,
          distinct_count,
          sample_values_json,
          top_values_json,
          truncated,
          profiled_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(object_id) DO UPDATE SET
          distinct_count = excluded.distinct_count,
          sample_values_json = excluded.sample_values_json,
          top_values_json = excluded.top_values_json,
          truncated = excluded.truncated,
          profiled_at = excluded.profiled_at
      `,
			[
				profile.id,
				profile.objectId,
				profile.distinctCount ?? null,
				JSON.stringify(profile.sampleValues),
				JSON.stringify(profile.topValues),
				profile.truncated ? 1 : 0,
				profile.profiledAt,
			],
		);

		return profile;
	}

	public async getValueProfile(
		objectId: string,
	): Promise<SemanticValueProfile | undefined> {
		await this.init();
		const rows = await this.queryRows(
			"SELECT * FROM semantic_value_profiles WHERE object_id = ?",
			[objectId],
		);
		const row = rows[0];
		return row ? semanticValueProfileFromRow(row) : undefined;
	}

	public async getCoverageReport(
		connectionId: string,
	): Promise<SemanticCoverageReport> {
		const objects = await this.listObjects({ connectionId, activeOnly: true });
		const annotations = await this.getLatestAnnotationMap(connectionId);
		const table = emptyCoverageByType();
		const column = emptyCoverageByType();

		for (const object of objects) {
			const bucket = object.objectType === "table" ? table : column;
			bucket.total += 1;
			if (object.stale) bucket.stale += 1;
			if (annotations.has(object.id)) bucket.enriched += 1;
		}

		table.missing = table.total - table.enriched;
		column.missing = column.total - column.enriched;

		return {
			connectionId,
			totalObjects: table.total + column.total,
			enrichedObjects: table.enriched + column.enriched,
			missingObjects: table.missing + column.missing,
			staleObjects: table.stale + column.stale,
			activeObjects: objects.length,
			byType: {
				table: freezeCoverage(table),
				column: freezeCoverage(column),
			},
		};
	}

	private async getClient(): Promise<SemanticSqlClient> {
		if (this.client) return this.client;

		if (this.databasePath !== ":memory:") {
			const dir = dirname(this.databasePath);
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		}

		this.client = await createLocalSqliteClient(this.databasePath);
		return this.client;
	}

	private async execute(
		sql: string,
		args: readonly SemanticSqlValue[] = [],
	): Promise<SemanticSqlResult> {
		const client = await this.getClient();
		return await client.execute({ sql, args });
	}

	private async queryRows(
		sql: string,
		args: readonly SemanticSqlValue[] = [],
	): Promise<Record<string, unknown>[]> {
		const result = await this.execute(sql, args);
		return result.rows.filter(isRecord);
	}

	private async getRelationshipById(
		relationshipId: string,
	): Promise<SemanticRelationship | undefined> {
		const rows = await this.queryRows(
			"SELECT * FROM semantic_relationships WHERE id = ?",
			[relationshipId],
		);
		const row = rows[0];
		return row ? semanticRelationshipFromRow(row) : undefined;
	}

	private async nextAnnotationVersion(objectId: string): Promise<number> {
		const rows = await this.queryRows(
			"SELECT MAX(version) AS version FROM semantic_annotations WHERE object_id = ?",
			[objectId],
		);
		const version = rows[0]?.version;
		return typeof version === "number" ? version + 1 : 1;
	}

	private nowIso(): string {
		return this.now().toISOString();
	}
}

export function semanticStoreExists(
	databasePath = LOCAL_SEMANTIC_DB_PATH,
): boolean {
	return existsSync(databasePath);
}

function semanticObjectFromRow(row: Record<string, unknown>): SemanticObject {
	const parsed = row as unknown as SemanticObjectRow;
	return {
		id: parsed.id,
		connectionId: parsed.connection_id,
		objectType: parsed.object_type === "column" ? "column" : "table",
		schemaName: parsed.schema_name,
		tableName: parsed.table_name,
		columnName: parsed.column_name ?? undefined,
		dataType: parsed.data_type ?? undefined,
		structuralHash: parsed.structural_hash,
		active: parsed.active === 1,
		stale: parsed.stale === 1,
		lastSeenAt: parsed.last_seen_at,
		createdAt: parsed.created_at,
		updatedAt: parsed.updated_at,
	};
}

function semanticAnnotationFromRow(
	row: Record<string, unknown>,
): SemanticAnnotation {
	const parsed = row as unknown as SemanticAnnotationRow;
	return {
		id: parsed.id,
		objectId: parsed.object_id,
		version: parsed.version,
		description: parsed.description,
		businessName: parsed.business_name ?? undefined,
		synonyms: parseStringArray(parsed.synonyms_json),
		notes: parsed.notes ?? undefined,
		source:
			parsed.source === "mcp"
				? "mcp"
				: parsed.source === "human"
					? "human"
					: "cli",
		createdAt: parsed.created_at,
	};
}

function semanticRelationshipFromRow(
	row: Record<string, unknown>,
): SemanticRelationship {
	const parsed = row as unknown as SemanticRelationshipRow;
	return {
		id: parsed.id,
		connectionId: parsed.connection_id,
		sourceObjectId: parsed.source_object_id,
		targetObjectId: parsed.target_object_id,
		relationshipType:
			parsed.relationship_type === "implicit" ? "implicit" : "foreign_key",
		constraintName: parsed.constraint_name ?? undefined,
		description: parsed.description ?? undefined,
		createdAt: parsed.created_at,
		updatedAt: parsed.updated_at,
	};
}

function semanticValueProfileFromRow(
	row: Record<string, unknown>,
): SemanticValueProfile {
	const parsed = row as unknown as SemanticValueProfileRow;
	return {
		id: parsed.id,
		objectId: parsed.object_id,
		distinctCount: parsed.distinct_count ?? undefined,
		sampleValues: parseStringArray(parsed.sample_values_json),
		topValues: parseTopValues(parsed.top_values_json),
		truncated: parsed.truncated === 1,
		profiledAt: parsed.profiled_at,
	};
}

function parseStringArray(value: string): readonly string[] {
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is string => typeof item === "string");
	} catch {
		return [];
	}
}

function parseTopValues(value: string): readonly SemanticValueFrequency[] {
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isSemanticValueFrequency);
	} catch {
		return [];
	}
}

function isSemanticValueFrequency(
	value: unknown,
): value is SemanticValueFrequency {
	if (!isRecord(value)) return false;
	return typeof value.value === "string" && typeof value.frequency === "number";
}

function normalizeOptionalString(
	value: string | undefined,
): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

function normalizeSynonyms(values: readonly string[]): readonly string[] {
	return [
		...new Set(
			values.map((value) => value.trim()).filter((value) => value.length > 0),
		),
	].sort((a, b) => a.localeCompare(b));
}

function emptyCoverageByType(): {
	total: number;
	enriched: number;
	missing: number;
	stale: number;
} {
	return {
		total: 0,
		enriched: 0,
		missing: 0,
		stale: 0,
	};
}

function freezeCoverage(value: {
	readonly total: number;
	readonly enriched: number;
	readonly missing: number;
	readonly stale: number;
}): SemanticCoverageByType {
	return {
		total: value.total,
		enriched: value.enriched,
		missing: value.missing,
		stale: value.stale,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
