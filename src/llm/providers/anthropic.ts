import type Anthropic from "@anthropic-ai/sdk";
import {
	buildSqlPrompt,
	buildSummaryPrompt,
	extractSqlAndExplanation,
	SQL_SYSTEM_PROMPT,
} from "@/llm/prompts.js";
import { importPackageFromStore } from "@/packages/lazy-packages.js";
import type {
	DatabaseSchema,
	LLMProvider,
	QueryResult,
	SqlGenerationResult,
	SummaryResult,
} from "@/types/index.js";

interface AnthropicModule {
	readonly default: new (options: { readonly apiKey: string }) => Anthropic;
}

export class AnthropicProvider implements LLMProvider {
	readonly providerName = "anthropic" as const;
	readonly modelName: string;
	private client: Anthropic;

	public static async create(
		apiKey: string,
		model = "claude-opus-4-5",
	): Promise<AnthropicProvider> {
		const module =
			await importPackageFromStore<AnthropicModule>("@anthropic-ai/sdk");
		return new AnthropicProvider(new module.default({ apiKey }), model);
	}

	constructor(client: Anthropic, model = "claude-opus-4-5") {
		this.client = client;
		this.modelName = model;
	}

	async generateSql(
		question: string,
		schema: DatabaseSchema,
		onChunk?: (chunk: string) => void,
	): Promise<SqlGenerationResult> {
		const start = Date.now();
		const prompt = buildSqlPrompt(question, schema);

		const stream = this.client.messages.stream({
			model: this.modelName,
			max_tokens: 2048,
			system: SQL_SYSTEM_PROMPT,
			messages: [{ role: "user", content: prompt }],
		});

		let fullText = "";
		let tokensIn = 0;
		let tokensOut = 0;

		for await (const event of stream) {
			if (
				event.type === "content_block_delta" &&
				event.delta.type === "text_delta"
			) {
				const text = event.delta.text;
				fullText += text;
				onChunk?.(text);
			}
		}

		const finalMessage = await stream.finalMessage();
		tokensIn = finalMessage.usage.input_tokens;
		tokensOut = finalMessage.usage.output_tokens;

		const { sql, explanation } = extractSqlAndExplanation(fullText);

		return {
			sql,
			explanation,
			tokensIn,
			tokensOut,
			latencyMs: Date.now() - start,
		};
	}

	async generateSummary(
		question: string,
		sql: string,
		results: QueryResult,
		onChunk?: (chunk: string) => void,
	): Promise<SummaryResult> {
		const start = Date.now();
		const prompt = buildSummaryPrompt(question, sql, results);

		const stream = this.client.messages.stream({
			model: this.modelName,
			max_tokens: 1024,
			messages: [{ role: "user", content: prompt }],
		});

		let fullText = "";
		let tokensIn = 0;
		let tokensOut = 0;

		for await (const event of stream) {
			if (
				event.type === "content_block_delta" &&
				event.delta.type === "text_delta"
			) {
				const text = event.delta.text;
				fullText += text;
				onChunk?.(text);
			}
		}

		const finalMessage = await stream.finalMessage();
		tokensIn = finalMessage.usage.input_tokens;
		tokensOut = finalMessage.usage.output_tokens;

		return {
			summary: fullText.trim(),
			tokensIn,
			tokensOut,
			latencyMs: Date.now() - start,
		};
	}

	async testConnectivity(): Promise<boolean> {
		try {
			await this.client.messages.create({
				model: this.modelName,
				max_tokens: 5,
				messages: [{ role: "user", content: "Reply with only: OK" }],
			});
			return true;
		} catch {
			return false;
		}
	}
}
