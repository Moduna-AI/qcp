export type SemanticObjectType = "table" | "column";

export type SemanticAnnotationSource = "cli" | "mcp" | "human";

export type SemanticRelationshipType = "foreign_key" | "implicit";

export interface SemanticObject {
	readonly id: string;
	readonly connectionId: string;
	readonly objectType: SemanticObjectType;
	readonly schemaName: string;
	readonly tableName: string;
	readonly columnName?: string;
	readonly dataType?: string;
	readonly structuralHash: string;
	readonly active: boolean;
	readonly stale: boolean;
	readonly lastSeenAt: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface SemanticAnnotation {
	readonly id: string;
	readonly objectId: string;
	readonly version: number;
	readonly description: string;
	readonly businessName?: string;
	readonly synonyms: readonly string[];
	readonly notes?: string;
	readonly source: SemanticAnnotationSource;
	readonly createdAt: string;
}

export interface SemanticRelationship {
	readonly id: string;
	readonly connectionId: string;
	readonly sourceObjectId: string;
	readonly targetObjectId: string;
	readonly relationshipType: SemanticRelationshipType;
	readonly constraintName?: string;
	readonly description?: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface SemanticValueFrequency {
	readonly value: string;
	readonly frequency: number;
}

export interface SemanticValueProfile {
	readonly id: string;
	readonly objectId: string;
	readonly distinctCount?: number;
	readonly sampleValues: readonly string[];
	readonly topValues: readonly SemanticValueFrequency[];
	readonly truncated: boolean;
	readonly profiledAt: string;
}

export interface SemanticContextObject extends SemanticObject {
	readonly annotation?: SemanticAnnotation;
	readonly score: number;
	readonly matchedTerms: readonly string[];
}

export interface SemanticContext {
	readonly connectionId: string;
	readonly query: string;
	readonly objects: readonly SemanticContextObject[];
	readonly relationships: readonly SemanticRelationship[];
	readonly missingObjects: readonly SemanticObject[];
	readonly coverage: SemanticCoverageReport;
	readonly generatedAt: string;
}

export interface SemanticCoverageByType {
	readonly total: number;
	readonly enriched: number;
	readonly missing: number;
	readonly stale: number;
}

export interface SemanticCoverageReport {
	readonly connectionId: string;
	readonly totalObjects: number;
	readonly enrichedObjects: number;
	readonly missingObjects: number;
	readonly staleObjects: number;
	readonly activeObjects: number;
	readonly byType: Record<SemanticObjectType, SemanticCoverageByType>;
}

export interface SemanticSyncReport {
	readonly connectionId: string;
	readonly syncedObjects: number;
	readonly syncedRelationships: number;
	readonly staleObjects: number;
	readonly inactiveObjects: number;
	readonly changedObjects: number;
}

export interface AddSemanticAnnotationInput {
	readonly objectId: string;
	readonly description: string;
	readonly businessName?: string;
	readonly synonyms?: readonly string[];
	readonly notes?: string;
	readonly source: SemanticAnnotationSource;
}

export interface UpsertSemanticObjectInput {
	readonly id: string;
	readonly connectionId: string;
	readonly objectType: SemanticObjectType;
	readonly schemaName: string;
	readonly tableName: string;
	readonly columnName?: string;
	readonly dataType?: string;
	readonly structuralHash: string;
}

export interface UpsertSemanticRelationshipInput {
	readonly id: string;
	readonly connectionId: string;
	readonly sourceObjectId: string;
	readonly targetObjectId: string;
	readonly relationshipType: SemanticRelationshipType;
	readonly constraintName?: string;
	readonly description?: string;
}

export interface UpsertSemanticValueProfileInput {
	readonly objectId: string;
	readonly distinctCount?: number;
	readonly sampleValues: readonly string[];
	readonly topValues: readonly SemanticValueFrequency[];
	readonly truncated: boolean;
}
