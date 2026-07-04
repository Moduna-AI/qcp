import type {
	SemanticSqlClient,
	SemanticSqlResult,
	SemanticSqlValue,
} from "./store.js";

interface SemanticObjectRow {
	id: string;
	connection_id: string;
	object_type: string;
	schema_name: string;
	table_name: string;
	column_name: string | null;
	data_type: string | null;
	structural_hash: string;
	active: number;
	stale: number;
	last_seen_at: string;
	created_at: string;
	updated_at: string;
}

interface SemanticAnnotationRow {
	id: string;
	object_id: string;
	version: number;
	description: string;
	business_name: string | null;
	synonyms_json: string;
	notes: string | null;
	source: string;
	created_at: string;
}

interface SemanticRelationshipRow {
	id: string;
	connection_id: string;
	source_object_id: string;
	target_object_id: string;
	relationship_type: string;
	constraint_name: string | null;
	description: string | null;
	created_at: string;
	updated_at: string;
}

interface SemanticValueProfileRow {
	id: string;
	object_id: string;
	distinct_count: number | null;
	sample_values_json: string;
	top_values_json: string;
	truncated: number;
	profiled_at: string;
}

export function createInMemorySemanticSqlClient(): SemanticSqlClient {
	return new InMemorySemanticSqlClient();
}

class InMemorySemanticSqlClient implements SemanticSqlClient {
	private readonly objects = new Map<string, SemanticObjectRow>();
	private readonly annotations: SemanticAnnotationRow[] = [];
	private readonly relationships = new Map<string, SemanticRelationshipRow>();
	private readonly valueProfiles = new Map<string, SemanticValueProfileRow>();

	public async execute(
		statement:
			| string
			| { readonly sql: string; readonly args?: readonly SemanticSqlValue[] },
	): Promise<SemanticSqlResult> {
		const sql = typeof statement === "string" ? statement : statement.sql;
		const args = typeof statement === "string" ? [] : (statement.args ?? []);
		const normalized = normalizeSql(sql);

		if (
			normalized.startsWith("create ") ||
			normalized.startsWith("create index")
		) {
			return { rows: [] };
		}

		if (normalized.startsWith("insert into semantic_objects")) {
			this.upsertObject(args);
			return { rows: [] };
		}
		if (
			normalized.startsWith("update semantic_objects set active = 0") ||
			normalized.includes("set active = 0, stale = 1")
		) {
			this.markObjectInactive(args);
			return { rows: [] };
		}
		if (
			normalized.startsWith("update semantic_objects set stale = 0") ||
			normalized.includes("set stale = 0")
		) {
			this.markObjectFresh(args);
			return { rows: [] };
		}
		if (normalized.startsWith("select id from semantic_objects")) {
			const connectionId = asString(args[0]);
			return {
				rows: [...this.objects.values()]
					.filter((row) => row.connection_id === connectionId)
					.slice(0, 1),
			};
		}
		if (normalized.startsWith("select * from semantic_objects where id = ?")) {
			const row = this.objects.get(asString(args[0]));
			return { rows: row ? [row] : [] };
		}
		if (normalized.includes("from semantic_objects")) {
			return { rows: this.listObjects(normalized, args) };
		}

		if (normalized.startsWith("select max(version)")) {
			const objectId = asString(args[0]);
			const versions = this.annotations
				.filter((row) => row.object_id === objectId)
				.map((row) => row.version);
			return {
				rows: [{ version: versions.length > 0 ? Math.max(...versions) : null }],
			};
		}
		if (normalized.startsWith("insert into semantic_annotations")) {
			this.annotations.push({
				id: asString(args[0]),
				object_id: asString(args[1]),
				version: asNumber(args[2]),
				description: asString(args[3]),
				business_name: asNullableString(args[4]),
				synonyms_json: asString(args[5]),
				notes: asNullableString(args[6]),
				source: asString(args[7]),
				created_at: asString(args[8]),
			});
			return { rows: [] };
		}
		if (
			normalized.includes("from semantic_annotations a") &&
			normalized.includes("join semantic_objects")
		) {
			return { rows: this.listLatestAnnotationRows(asString(args[0])) };
		}
		if (normalized.includes("from semantic_annotations")) {
			return {
				rows: this.annotations
					.filter((row) => row.object_id === asString(args[0]))
					.sort((a, b) => a.version - b.version),
			};
		}

		if (normalized.startsWith("delete from semantic_relationships")) {
			const connectionId = asString(args[0]);
			for (const [id, row] of this.relationships) {
				if (
					row.connection_id === connectionId &&
					row.relationship_type === "foreign_key"
				) {
					this.relationships.delete(id);
				}
			}
			return { rows: [] };
		}
		if (normalized.startsWith("insert into semantic_relationships")) {
			this.upsertRelationship(args);
			return { rows: [] };
		}
		if (
			normalized.startsWith("select * from semantic_relationships where id = ?")
		) {
			const row = this.relationships.get(asString(args[0]));
			return { rows: row ? [row] : [] };
		}
		if (normalized.includes("from semantic_relationships")) {
			return {
				rows: [...this.relationships.values()]
					.filter((row) => row.connection_id === asString(args[0]))
					.sort((a, b) => a.id.localeCompare(b.id)),
			};
		}

		if (normalized.startsWith("insert into semantic_value_profiles")) {
			this.upsertValueProfile(args);
			return { rows: [] };
		}
		if (normalized.includes("from semantic_value_profiles")) {
			const row = this.valueProfiles.get(asString(args[0]));
			return { rows: row ? [row] : [] };
		}

		throw new Error(`Unhandled semantic test SQL: ${normalized}`);
	}

	public close(): void {}

	private upsertObject(args: readonly SemanticSqlValue[]): void {
		const id = asString(args[0]);
		const existing = this.objects.get(id);
		this.objects.set(id, {
			id,
			connection_id: asString(args[1]),
			object_type: asString(args[2]),
			schema_name: asString(args[3]),
			table_name: asString(args[4]),
			column_name: asNullableString(args[5]),
			data_type: asNullableString(args[6]),
			structural_hash: asString(args[7]),
			active: 1,
			stale: asNumber(args[8]),
			last_seen_at: asString(args[9]),
			created_at: asString(args[10]) || existing?.created_at || "",
			updated_at: asString(args[11]),
		});
	}

	private markObjectInactive(args: readonly SemanticSqlValue[]): void {
		const row = this.objects.get(asString(args[1]));
		if (!row) return;
		row.active = 0;
		row.stale = 1;
		row.updated_at = asString(args[0]);
	}

	private markObjectFresh(args: readonly SemanticSqlValue[]): void {
		const row = this.objects.get(asString(args[1]));
		if (!row) return;
		row.stale = 0;
		row.updated_at = asString(args[0]);
	}

	private listObjects(
		normalizedSql: string,
		args: readonly SemanticSqlValue[],
	): SemanticObjectRow[] {
		const connectionId = asString(args[0]);
		const objectType =
			normalizedSql.includes("object_type = ?") && args.length > 1
				? asString(args[1])
				: null;
		return [...this.objects.values()]
			.filter((row) => row.connection_id === connectionId)
			.filter(
				(row) => !normalizedSql.includes("active = 1") || row.active === 1,
			)
			.filter((row) => objectType === null || row.object_type === objectType)
			.sort((a, b) =>
				[a.schema_name, a.table_name, a.column_name ?? "", a.object_type]
					.join(".")
					.localeCompare(
						[
							b.schema_name,
							b.table_name,
							b.column_name ?? "",
							b.object_type,
						].join("."),
					),
			);
	}

	private listLatestAnnotationRows(
		connectionId: string,
	): SemanticAnnotationRow[] {
		const objectIds = new Set(
			[...this.objects.values()]
				.filter((row) => row.connection_id === connectionId)
				.map((row) => row.id),
		);
		const latest = new Map<string, SemanticAnnotationRow>();
		for (const row of this.annotations) {
			if (!objectIds.has(row.object_id)) continue;
			const current = latest.get(row.object_id);
			if (!current || row.version > current.version) {
				latest.set(row.object_id, row);
			}
		}
		return [...latest.values()].sort(
			(a, b) => a.object_id.localeCompare(b.object_id) || b.version - a.version,
		);
	}

	private upsertRelationship(args: readonly SemanticSqlValue[]): void {
		const id = asString(args[0]);
		const existing = this.relationships.get(id);
		this.relationships.set(id, {
			id,
			connection_id: asString(args[1]),
			source_object_id: asString(args[2]),
			target_object_id: asString(args[3]),
			relationship_type: asString(args[4]),
			constraint_name: asNullableString(args[5]),
			description: asNullableString(args[6]),
			created_at: asString(args[7]) || existing?.created_at || "",
			updated_at: asString(args[8]),
		});
	}

	private upsertValueProfile(args: readonly SemanticSqlValue[]): void {
		this.valueProfiles.set(asString(args[1]), {
			id: asString(args[0]),
			object_id: asString(args[1]),
			distinct_count: asNullableNumber(args[2]),
			sample_values_json: asString(args[3]),
			top_values_json: asString(args[4]),
			truncated: asNumber(args[5]),
			profiled_at: asString(args[6]),
		});
	}
}

function normalizeSql(sql: string): string {
	return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function asString(value: SemanticSqlValue | undefined): string {
	return value === null || value === undefined ? "" : String(value);
}

function asNullableString(value: SemanticSqlValue | undefined): string | null {
	return value === null || value === undefined ? null : String(value);
}

function asNumber(value: SemanticSqlValue | undefined): number {
	if (typeof value === "number") return value;
	if (typeof value === "bigint") return Number(value);
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function asNullableNumber(value: SemanticSqlValue | undefined): number | null {
	return value === null || value === undefined ? null : asNumber(value);
}
