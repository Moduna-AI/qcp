import type { SemanticStore } from "./store.js";
import type {
	SemanticAnnotation,
	SemanticContext,
	SemanticContextObject,
	SemanticObject,
	SemanticRelationship,
} from "./types.js";

export interface SemanticContextRetrieverOptions {
	readonly store: SemanticStore;
	readonly now?: () => Date;
}

export interface RetrieveSemanticContextOptions {
	readonly connectionId: string;
	readonly query: string;
	readonly maxObjects?: number;
	readonly includeForeignKeyNeighbors?: boolean;
}

interface ScoredObject {
	readonly object: SemanticObject;
	readonly annotation?: SemanticAnnotation;
	readonly score: number;
	readonly matchedTerms: readonly string[];
}

export class SemanticContextRetriever {
	private readonly store: SemanticStore;
	private readonly now: () => Date;

	public constructor(options: SemanticContextRetrieverOptions) {
		this.store = options.store;
		this.now = options.now ?? (() => new Date());
	}

	public async retrieve(
		options: RetrieveSemanticContextOptions,
	): Promise<SemanticContext> {
		const maxObjects = Math.max(1, options.maxObjects ?? 12);
		const objects = await this.store.listObjects({
			connectionId: options.connectionId,
			activeOnly: true,
		});
		const annotations = await this.store.getLatestAnnotationMap(
			options.connectionId,
		);
		const relationships = await this.store.listRelationships(
			options.connectionId,
		);
		const queryTokens = tokenize(options.query);

		const scored = objects
			.map((object) =>
				scoreObject({
					object,
					annotation: annotations.get(object.id),
					query: options.query,
					queryTokens,
				}),
			)
			.filter((item) => item.score > 0)
			.sort(compareScoredObjects);

		const selectedIds = new Set(
			scored.slice(0, maxObjects).map((item) => item.object.id),
		);

		addParentTables(selectedIds, objects);
		if (options.includeForeignKeyNeighbors ?? true) {
			addForeignKeyNeighbors(selectedIds, objects, relationships);
		}

		const scoredById = new Map(scored.map((item) => [item.object.id, item]));
		const selectedObjects = objects
			.filter((object) => selectedIds.has(object.id))
			.map((object): SemanticContextObject => {
				const scoredObject = scoredById.get(object.id);
				return {
					...object,
					annotation: annotations.get(object.id),
					score: scoredObject?.score ?? 0,
					matchedTerms: scoredObject?.matchedTerms ?? [],
				};
			})
			.sort(
				(a, b) =>
					b.score - a.score || objectSortKey(a).localeCompare(objectSortKey(b)),
			);

		const selectedRelationships = relationships.filter((relationship) =>
			relationshipTouchesSelectedObject(relationship, selectedIds, objects),
		);

		return {
			connectionId: options.connectionId,
			query: options.query,
			objects: selectedObjects,
			relationships: selectedRelationships,
			missingObjects: selectedObjects.filter(
				(object) => object.annotation === undefined,
			),
			coverage: await this.store.getCoverageReport(options.connectionId),
			generatedAt: this.now().toISOString(),
		};
	}
}

function scoreObject(input: {
	readonly object: SemanticObject;
	readonly annotation?: SemanticAnnotation;
	readonly query: string;
	readonly queryTokens: readonly string[];
}): ScoredObject {
	const nameTokens = tokenize(
		[
			input.object.schemaName,
			input.object.tableName,
			input.object.columnName,
			qualifiedObjectName(input.object),
		]
			.filter((value): value is string => typeof value === "string")
			.join(" "),
	);
	const semanticTokens = tokenize(
		[
			input.annotation?.description,
			input.annotation?.businessName,
			input.annotation?.synonyms.join(" "),
			input.annotation?.notes,
		]
			.filter((value): value is string => typeof value === "string")
			.join(" "),
	);
	const lowerQuery = input.query.toLowerCase();
	const matched = new Set<string>();
	let score = 0;

	for (const token of input.queryTokens) {
		if (nameTokens.includes(token)) {
			score += 5;
			matched.add(token);
		}
		if (semanticTokens.includes(token)) {
			score += 3;
			matched.add(token);
		}
	}

	const objectNames = [
		input.object.tableName,
		input.object.columnName,
		qualifiedObjectName(input.object),
		input.annotation?.businessName,
		...(input.annotation?.synonyms ?? []),
	].filter((value): value is string => typeof value === "string");

	for (const name of objectNames) {
		const normalized = name.toLowerCase();
		if (normalized.length >= 3 && lowerQuery.includes(normalized)) {
			score += name === input.annotation?.businessName ? 6 : 4;
			for (const token of tokenize(name)) matched.add(token);
		}
	}

	if (input.object.objectType === "table") score += 0.25;

	return {
		object: input.object,
		annotation: input.annotation,
		score,
		matchedTerms: [...matched].sort((a, b) => a.localeCompare(b)),
	};
}

function addParentTables(
	selectedIds: Set<string>,
	objects: readonly SemanticObject[],
): void {
	const tableByKey = tableObjectByKey(objects);
	for (const object of objects) {
		if (object.objectType !== "column" || !selectedIds.has(object.id)) continue;
		const table = tableByKey.get(tableKey(object));
		if (table) selectedIds.add(table.id);
	}
}

function addForeignKeyNeighbors(
	selectedIds: Set<string>,
	objects: readonly SemanticObject[],
	relationships: readonly SemanticRelationship[],
): void {
	const objectById = new Map(objects.map((object) => [object.id, object]));
	const tableByKey = tableObjectByKey(objects);

	for (const relationship of relationships) {
		if (relationship.relationshipType !== "foreign_key") continue;
		const source = objectById.get(relationship.sourceObjectId);
		const target = objectById.get(relationship.targetObjectId);
		if (!source || !target) continue;

		const sourceTable = tableByKey.get(tableKey(source));
		const targetTable = tableByKey.get(tableKey(target));
		const sourceSelected =
			selectedIds.has(source.id) ||
			(sourceTable ? selectedIds.has(sourceTable.id) : false);
		const targetSelected =
			selectedIds.has(target.id) ||
			(targetTable ? selectedIds.has(targetTable.id) : false);

		if (sourceSelected) {
			selectedIds.add(target.id);
			if (targetTable) selectedIds.add(targetTable.id);
		}
		if (targetSelected) {
			selectedIds.add(source.id);
			if (sourceTable) selectedIds.add(sourceTable.id);
		}
	}
}

function relationshipTouchesSelectedObject(
	relationship: SemanticRelationship,
	selectedIds: ReadonlySet<string>,
	objects: readonly SemanticObject[],
): boolean {
	if (
		selectedIds.has(relationship.sourceObjectId) ||
		selectedIds.has(relationship.targetObjectId)
	) {
		return true;
	}

	const objectById = new Map(objects.map((object) => [object.id, object]));
	const tableByKey = tableObjectByKey(objects);
	const source = objectById.get(relationship.sourceObjectId);
	const target = objectById.get(relationship.targetObjectId);
	const sourceTable = source ? tableByKey.get(tableKey(source)) : undefined;
	const targetTable = target ? tableByKey.get(tableKey(target)) : undefined;

	return (
		(sourceTable ? selectedIds.has(sourceTable.id) : false) ||
		(targetTable ? selectedIds.has(targetTable.id) : false)
	);
}

function tableObjectByKey(
	objects: readonly SemanticObject[],
): Map<string, SemanticObject> {
	return new Map(
		objects
			.filter((object) => object.objectType === "table")
			.map((object) => [tableKey(object), object]),
	);
}

function tableKey(object: SemanticObject): string {
	return `${object.schemaName}.${object.tableName}`;
}

function qualifiedObjectName(object: SemanticObject): string {
	const table =
		object.schemaName === "public"
			? object.tableName
			: `${object.schemaName}.${object.tableName}`;
	return object.columnName ? `${table}.${object.columnName}` : table;
}

function compareScoredObjects(a: ScoredObject, b: ScoredObject): number {
	return (
		b.score - a.score ||
		objectSortKey(a.object).localeCompare(objectSortKey(b.object))
	);
}

function objectSortKey(object: SemanticObject): string {
	return [
		object.schemaName,
		object.tableName,
		object.columnName ?? "",
		object.objectType,
	].join(".");
}

function tokenize(value: string): readonly string[] {
	const tokens = value
		.toLowerCase()
		.split(/[^a-z0-9]+/g)
		.map((token) => token.trim())
		.filter((token) => token.length >= 2);

	const expanded = new Set<string>();
	for (const token of tokens) {
		expanded.add(token);
		if (token.endsWith("s") && token.length > 3) {
			expanded.add(token.slice(0, -1));
		}
	}
	return [...expanded];
}
