import { describe, expect, test } from "bun:test";
import type { ToolsInput } from "@mastra/core/agent";
import type { ToolAction } from "@mastra/core/tools";
import type {
	ActiveDatabaseConnection,
	DatabaseSchema,
} from "@/types/index.js";
import { SemanticSchemaIndexer } from "./indexer.js";
import {
	HumanSemanticQuestionService,
	type SemanticQuestionAdapter,
	type SemanticQuestionResponse,
} from "./question-service.js";
import { SemanticStore } from "./store.js";
import { createInMemorySemanticSqlClient } from "./test-client.js";
import { createSemanticTools } from "./tools.js";
import type { SemanticObject } from "./types.js";

describe("semantic tools", () => {
	test("retrieves context and performs inline enrichment with a mocked prompt", async () => {
		const store = new SemanticStore({
			client: createInMemorySemanticSqlClient(),
		});
		try {
			await new SemanticSchemaIndexer(store).sync(connection, schema());
			const service = new HumanSemanticQuestionService({
				store,
				cliAdapter: new AcceptingPromptAdapter(),
			});
			const tools = createSemanticTools({
				store,
				connectionId: connection.id,
				questionService: service,
				maxInlinePrompts: 1,
			});

			const output = await executeTool(tools, "qcp_read_semantic_context", {
				query: "users",
				maxObjects: 5,
				enrichMissing: true,
			});
			const context = output as {
				readonly enrichment: { readonly accepted: number };
				readonly objects: readonly {
					readonly annotation?: { readonly source: string };
				}[];
			};

			expect(context.enrichment.accepted).toBe(1);
			expect(
				context.objects.some((object) => object.annotation?.source === "cli"),
			).toBe(true);
		} finally {
			await store.close();
		}
	});
});

class AcceptingPromptAdapter implements SemanticQuestionAdapter {
	public async requestAnnotation(
		object: SemanticObject,
	): Promise<SemanticQuestionResponse> {
		return {
			status: "accepted",
			source: "cli",
			draft: {
				description: `Meaning for ${object.tableName}`,
				synonyms: ["mocked"],
			},
		};
	}
}

async function executeTool(
	tools: ToolsInput,
	name: string,
	input: unknown,
	context: unknown = {},
): Promise<unknown> {
	const tool = tools[name] as
		| ToolAction<unknown, unknown, unknown, unknown>
		| undefined;
	if (!tool?.execute) {
		throw new Error(`Tool not found: ${name}`);
	}

	return tool.execute(input, context as never);
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
