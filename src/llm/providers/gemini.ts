import { GoogleGenerativeAI } from "@google/generative-ai";
import {
	buildSqlPrompt,
	buildSummaryPrompt,
	extractSqlAndExplanation,
	SQL_SYSTEM_PROMPT,
} from "@/llm/prompts.js";
import type {
	DatabaseSchema,
	LLMProvider,
	QueryResult,
	SqlGenerationResult,
	SummaryResult,
} from "@/types/index.js";

export class GeminiProvider implements LLMProvider {
	readonly providerName = "gemini" as const;
	readonly modelName: string;
	private client: GoogleGenerativeAI;

	constructor(apiKey: string, model = "gemini-2.5-flash") {
		this.client = new GoogleGenerativeAI(apiKey);
		this.modelName = model;
	}

	async generateSql(
		question: string,
		schema: DatabaseSchema,
		onChunk?: (chunk: string) => void,
	): Promise<SqlGenerationResult> {
		const start = Date.now();
		const prompt = buildSqlPrompt(question, schema);

		const genModel = this.client.getGenerativeModel({
			model: this.modelName,
			systemInstruction: SQL_SYSTEM_PROMPT,
		});

		const streamResult = await genModel.generateContentStream(prompt);

		let fullText = "";
		let tokensIn = 0;
		let tokensOut = 0;

		for await (const chunk of streamResult.stream) {
			const text = chunk.text();
			if (text) {
				fullText += text;
				onChunk?.(text);
			}
		}

		// Get usage metadata from final response
		try {
			const finalResponse = await streamResult.response;
			tokensIn = finalResponse.usageMetadata?.promptTokenCount ?? 0;
			tokensOut = finalResponse.usageMetadata?.candidatesTokenCount ?? 0;
		} catch {
			// ignore token count errors
		}

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
		const genModel = this.client.getGenerativeModel({
			model: this.modelName,
		});
		let fullText = "";
		let tokensIn = 0;
		let tokensOut = 0;
		try {
			const streamResult = await genModel.generateContentStream(prompt);
			for await (const chunk of streamResult.stream) {
				const text = chunk.text();
				if (!text) continue;
				fullText += text;
				onChunk?.(text);
			}
			try {
				const response = await streamResult.response;
				tokensIn = response.usageMetadata?.promptTokenCount ?? 0;
				tokensOut = response.usageMetadata?.candidatesTokenCount ?? 0;
			} catch {
				// ignore usage metadata errors
			}
		} catch (streamError) {
			// Fallback to non-streaming
			const result = await genModel.generateContent(prompt);
			const response = result.response;
			fullText = response.text();
			onChunk?.(fullText);
			tokensIn = response.usageMetadata?.promptTokenCount ?? 0;
			tokensOut = response.usageMetadata?.candidatesTokenCount ?? 0;
			console.warn(
				`Streaming failed, fell back to standard generation: ${
					streamError instanceof Error
						? streamError.message
						: String(streamError)
				}`,
			);
		}
		return {
			summary: fullText.trim(),
			tokensIn,
			tokensOut,
			latencyMs: Date.now() - start,
		};
	}

	async testConnectivity(): Promise<boolean> {
		try {
			const genModel = this.client.getGenerativeModel({
				model: this.modelName,
			});
			await genModel.generateContent("Reply with only the word: OK");
			return true;
		} catch {
			return false;
		}
	}
}
