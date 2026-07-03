import { describe, expect, test } from "bun:test";
import type {
	ActiveDatabaseConnection,
	DatabaseSchema,
} from "@/types/index.js";
import { SemanticSchemaIndexer, semanticObjectId } from "./indexer.js";
import {
	HumanSemanticQuestionService,
	McpSemanticQuestionAdapter,
} from "./question-service.js";
import { SemanticStore } from "./store.js";
import { createInMemorySemanticSqlClient } from "./test-client.js";

describe("HumanSemanticQuestionService", () => {
	test("stores MCP accepted semantic annotations", async () => {
		const { store, objectId } = await preparedStore();
		try {
			const service = new HumanSemanticQuestionService({
				store,
				mcpAdapter: new McpSemanticQuestionAdapter(),
			});
			const object = await store.getObjectById(objectId);
			if (!object) throw new Error("Fixture object missing");

			const result = await service.enrichObjects([object], {
				context: mcpContext({
					action: "accept",
					content: {
						description: "Customers in the product.",
						businessName: "Customer",
						synonyms: "account, user",
						notes: "Human-authored",
					},
				}),
			});

			expect(result.accepted).toBe(1);
			const annotations = await store.listAnnotationsForObject(objectId);
			expect(annotations[0]?.source).toBe("mcp");
			expect(annotations[0]?.synonyms).toEqual(["account", "user"]);
		} finally {
			await store.close();
		}
	});

	test("tracks MCP decline and cancel without writing annotations", async () => {
		const declined = await preparedStore();
		const cancelled = await preparedStore();
		try {
			const declinedObject = await declined.store.getObjectById(
				declined.objectId,
			);
			const cancelledObject = await cancelled.store.getObjectById(
				cancelled.objectId,
			);
			if (!declinedObject || !cancelledObject) {
				throw new Error("Fixture object missing");
			}

			const service = new HumanSemanticQuestionService({
				store: declined.store,
				mcpAdapter: new McpSemanticQuestionAdapter(),
			});
			const declineResult = await service.enrichObjects([declinedObject], {
				context: mcpContext({ action: "decline" }),
			});
			expect(declineResult.declined).toBe(1);
			expect(
				await declined.store.listAnnotationsForObject(declined.objectId),
			).toEqual([]);

			const cancelService = new HumanSemanticQuestionService({
				store: cancelled.store,
				mcpAdapter: new McpSemanticQuestionAdapter(),
			});
			const cancelResult = await cancelService.enrichObjects(
				[cancelledObject],
				{
					context: mcpContext({ action: "cancel" }),
				},
			);
			expect(cancelResult.cancelled).toBe(1);
			expect(
				await cancelled.store.listAnnotationsForObject(cancelled.objectId),
			).toEqual([]);
		} finally {
			await declined.store.close();
			await cancelled.store.close();
		}
	});
});

interface PreparedStore {
	readonly store: SemanticStore;
	readonly objectId: string;
}

async function preparedStore(): Promise<PreparedStore> {
	const store = new SemanticStore({
		client: createInMemorySemanticSqlClient(),
	});
	await new SemanticSchemaIndexer(store).sync(connection, schema());
	const objectId = semanticObjectId({
		connectionId: connection.id,
		objectType: "table",
		schemaName: "public",
		tableName: "users",
	});
	return { store, objectId };
}

function mcpContext(result: {
	readonly action: string;
	readonly content?: unknown;
}): unknown {
	return {
		mcp: {
			elicitation: {
				sendRequest: async () => result,
			},
		},
	};
}

const connection: ActiveDatabaseConnection = {
	id: "conn-1",
	name: "local",
	databaseType: "other-postgres",
	databaseUrl: "postgres://example/app",
};

function schema(): DatabaseSchema {
	return {
		scannedAt: "2026-07-03T00:00:00.000Z",
		databaseName: "app",
		tableCount: 1,
		tables: [
			{
				schema: "public",
				name: "users",
				primaryKeys: ["id"],
				columns: [
					{ name: "id", type: "integer", nullable: false, isPrimaryKey: true },
					{ name: "email", type: "text", nullable: true, isPrimaryKey: false },
				],
				foreignKeys: [],
				indexes: [],
			},
		],
	};
}
