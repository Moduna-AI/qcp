import type { ToolsInput } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { AuditContext } from "@/logger/audit.js";
import { writeSemanticAuditEvent } from "./audit.js";
import type { HumanSemanticQuestionService } from "./question-service.js";
import { SemanticContextRetriever } from "./retriever.js";
import type { SemanticStore } from "./store.js";
import type { SemanticContext } from "./types.js";

export interface CreateSemanticToolsOptions {
	readonly store: SemanticStore;
	readonly connectionId: string;
	readonly retriever?: SemanticContextRetriever;
	readonly questionService?: HumanSemanticQuestionService;
	readonly maxInlinePrompts?: number;
	readonly auditContext?: AuditContext;
}

const semanticAnnotationSchema = z.object({
	id: z.string(),
	objectId: z.string(),
	version: z.number(),
	description: z.string(),
	businessName: z.string().optional(),
	synonyms: z.array(z.string()),
	notes: z.string().optional(),
	source: z.enum(["cli", "mcp", "human"]),
	createdAt: z.string(),
});

const semanticObjectSchema = z.object({
	id: z.string(),
	connectionId: z.string(),
	objectType: z.enum(["table", "column"]),
	schemaName: z.string(),
	tableName: z.string(),
	columnName: z.string().optional(),
	dataType: z.string().optional(),
	structuralHash: z.string(),
	active: z.boolean(),
	stale: z.boolean(),
	lastSeenAt: z.string(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

const semanticContextObjectSchema = semanticObjectSchema.extend({
	annotation: semanticAnnotationSchema.optional(),
	score: z.number(),
	matchedTerms: z.array(z.string()),
});

const semanticRelationshipSchema = z.object({
	id: z.string(),
	connectionId: z.string(),
	sourceObjectId: z.string(),
	targetObjectId: z.string(),
	relationshipType: z.enum(["foreign_key", "implicit"]),
	constraintName: z.string().optional(),
	description: z.string().optional(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

const semanticCoverageByTypeSchema = z.object({
	total: z.number(),
	enriched: z.number(),
	missing: z.number(),
	stale: z.number(),
});

const semanticCoverageSchema = z.object({
	connectionId: z.string(),
	totalObjects: z.number(),
	enrichedObjects: z.number(),
	missingObjects: z.number(),
	staleObjects: z.number(),
	activeObjects: z.number(),
	byType: z.object({
		table: semanticCoverageByTypeSchema,
		column: semanticCoverageByTypeSchema,
	}),
});

const enrichmentRunSchema = z.object({
	asked: z.number(),
	accepted: z.number(),
	declined: z.number(),
	cancelled: z.number(),
	skipped: z.number(),
});

const semanticContextSchema = z.object({
	connectionId: z.string(),
	query: z.string(),
	objects: z.array(semanticContextObjectSchema),
	relationships: z.array(semanticRelationshipSchema),
	missingObjects: z.array(semanticObjectSchema),
	coverage: semanticCoverageSchema,
	generatedAt: z.string(),
	enrichment: enrichmentRunSchema,
});

export function createSemanticTools(
	options: CreateSemanticToolsOptions,
): ToolsInput {
	const retriever =
		options.retriever ??
		new SemanticContextRetriever({
			store: options.store,
		});

	return {
		qcp_read_semantic_context: createTool({
			id: "qcp_read_semantic_context",
			description:
				"Retrieve local human-authored semantic schema context for a natural-language database question. Uses deterministic keyword ranking and FK-neighbor expansion.",
			inputSchema: z.object({
				query: z.string().min(1),
				maxObjects: z.number().int().min(1).max(50).optional(),
				enrichMissing: z.boolean().optional(),
			}),
			outputSchema: semanticContextSchema,
			mcp: {
				annotations: {
					title: "Read Semantic Context",
					readOnlyHint: false,
					destructiveHint: false,
					idempotentHint: false,
					openWorldHint: false,
				},
			},
			execute: async ({ query, maxObjects, enrichMissing }, context) => {
				let semanticContext = await retriever.retrieve({
					connectionId: options.connectionId,
					query,
					maxObjects,
				});
				const shouldEnrich =
					(enrichMissing ?? true) && semanticContext.missingObjects.length > 0;
				const enrichment =
					shouldEnrich && options.questionService
						? await options.questionService.enrichObjects(
								semanticContext.missingObjects,
								{
									maxQuestions: options.maxInlinePrompts ?? 3,
									context,
								},
							)
						: {
								asked: 0,
								accepted: 0,
								declined: 0,
								cancelled: 0,
								skipped: shouldEnrich
									? semanticContext.missingObjects.length
									: 0,
								annotations: [],
							};

				if (enrichment.accepted > 0) {
					await writeSemanticAuditEvent({
						context: options.auditContext,
						action: "SEMANTIC_ANNOTATION",
						outcome: "success",
						metadata: {
							objectCount: enrichment.accepted,
							source: "agent_tool",
						},
					});
					semanticContext = await retriever.retrieve({
						connectionId: options.connectionId,
						query,
						maxObjects,
					});
				}

				return serializeSemanticContext(semanticContext, {
					asked: enrichment.asked,
					accepted: enrichment.accepted,
					declined: enrichment.declined,
					cancelled: enrichment.cancelled,
					skipped: enrichment.skipped,
				});
			},
		}),
		qcp_request_schema_enrichment: createTool({
			id: "qcp_request_schema_enrichment",
			description:
				"Ask the user to add human-authored semantic meaning for specific schema object IDs. Use only when semantic context reports missing objects.",
			inputSchema: z.object({
				objectIds: z.array(z.string()).min(1).max(20),
			}),
			outputSchema: z.object({
				requestedObjectIds: z.array(z.string()),
				missingObjectIds: z.array(z.string()),
				enrichment: enrichmentRunSchema,
			}),
			mcp: {
				annotations: {
					title: "Request Schema Enrichment",
					readOnlyHint: false,
					destructiveHint: false,
					idempotentHint: false,
					openWorldHint: false,
				},
			},
			execute: async ({ objectIds }, context) => {
				const requestedObjects = await options.store.getObjectsByIds(objectIds);
				const annotations = await options.store.getLatestAnnotationMap(
					options.connectionId,
				);
				const missingObjects = requestedObjects.filter(
					(object) => !annotations.has(object.id),
				);
				const enrichment = options.questionService
					? await options.questionService.enrichObjects(missingObjects, {
							context,
						})
					: {
							asked: 0,
							accepted: 0,
							declined: 0,
							cancelled: 0,
							skipped: missingObjects.length,
							annotations: [],
						};

				if (enrichment.accepted > 0) {
					await writeSemanticAuditEvent({
						context: options.auditContext,
						action: "SEMANTIC_ANNOTATION",
						outcome: "success",
						metadata: {
							objectCount: enrichment.accepted,
							source: "agent_tool",
						},
					});
				}

				return {
					requestedObjectIds: objectIds,
					missingObjectIds: missingObjects.map((object) => object.id),
					enrichment: {
						asked: enrichment.asked,
						accepted: enrichment.accepted,
						declined: enrichment.declined,
						cancelled: enrichment.cancelled,
						skipped: enrichment.skipped,
					},
				};
			},
		}),
	};
}

function serializeSemanticContext(
	context: SemanticContext,
	enrichment: {
		readonly asked: number;
		readonly accepted: number;
		readonly declined: number;
		readonly cancelled: number;
		readonly skipped: number;
	},
) {
	return {
		connectionId: context.connectionId,
		query: context.query,
		objects: context.objects.map((object) => ({
			...object,
			matchedTerms: [...object.matchedTerms],
			annotation: object.annotation
				? {
						...object.annotation,
						synonyms: [...object.annotation.synonyms],
					}
				: undefined,
		})),
		relationships: context.relationships.map((relationship) => ({
			...relationship,
		})),
		missingObjects: context.missingObjects.map((object) => ({
			...object,
		})),
		coverage: {
			...context.coverage,
			byType: {
				table: { ...context.coverage.byType.table },
				column: { ...context.coverage.byType.column },
			},
		},
		generatedAt: context.generatedAt,
		enrichment: { ...enrichment },
	};
}
