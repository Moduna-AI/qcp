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

export class OllamaProvider implements LLMProvider {
	readonly providerName = "ollama" as const;
	readonly modelName: string;
	private host: string;

	constructor(model = "qwen3", host = "http://localhost:11434") {
		this.modelName = model;
		this.host = host.replace(/\/$/, "");
	}

	async generateSql(
		question: string,
		schema: DatabaseSchema,
		onChunk?: (chunk: string) => void,
	): Promise<SqlGenerationResult> {
		const start = Date.now();
		const prompt = buildSqlPrompt(question, schema);

		const fullText = await this.streamChat(
			[
				{ role: "system", content: SQL_SYSTEM_PROMPT },
				{ role: "user", content: prompt },
			],
			onChunk,
		);

		const { sql, explanation } = extractSqlAndExplanation(fullText);

		return {
			sql,
			explanation,
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

		const fullText = await this.streamChat(
			[{ role: "user", content: prompt }],
			onChunk,
		);

		return {
			summary: fullText.trim(),
			latencyMs: Date.now() - start,
		};
	}

	async testConnectivity(): Promise<boolean> {
		try {
			const response = await fetch(`${this.host}/api/tags`, {
				signal: AbortSignal.timeout(5000),
			});
			if (!response.ok) return false;
			const data = (await response.json()) as { models?: unknown[] };
			return Array.isArray(data.models);
		} catch {
			return false;
		}
	}

	private async streamChat(
		messages: Array<{ role: string; content: string }>,
		onChunk?: (chunk: string) => void,
	): Promise<string> {
		const response = await fetch(`${this.host}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: this.modelName,
				messages,
				stream: true,
			}),
			signal: AbortSignal.timeout(120_000),
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Ollama error ${response.status}: ${text}`);
		}

		if (!response.body) {
			throw new Error("Ollama: empty response body");
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let fullText = "";

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			const chunk = decoder.decode(value, { stream: true });
			const lines = chunk.split("\n").filter((l) => l.trim());

			for (const line of lines) {
				try {
					const json = JSON.parse(line) as {
						message?: { content?: string };
						done?: boolean;
					};
					const text = json.message?.content ?? "";
					if (text) {
						fullText += text;
						onChunk?.(text);
					}
				} catch {
					// ignore malformed JSON lines
				}
			}
		}

		return fullText;
	}
}
