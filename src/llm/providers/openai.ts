import OpenAI from 'openai';
import type { LLMProvider, DatabaseSchema, SqlGenerationResult, SummaryResult, QueryResult } from '../../types/index.js';
import { SQL_SYSTEM_PROMPT, buildSqlPrompt, buildSummaryPrompt, extractSqlAndExplanation } from '../prompts.js';

export class OpenAIProvider implements LLMProvider {
  readonly providerName = 'openai' as const;
  readonly modelName: string;
  private client: OpenAI;

  constructor(apiKey: string, model = 'gpt-4o') {
    this.client = new OpenAI({ apiKey });
    this.modelName = model;
  }

  async generateSql(
    question: string,
    schema: DatabaseSchema,
    onChunk?: (chunk: string) => void
  ): Promise<SqlGenerationResult> {
    const start = Date.now();
    const prompt = buildSqlPrompt(question, schema);

    const stream = await this.client.chat.completions.create({
      model: this.modelName,
      messages: [
        { role: 'system', content: SQL_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      stream: true,
      stream_options: { include_usage: true },
    });

    let fullText = '';
    let tokensIn = 0;
    let tokensOut = 0;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? '';
      if (delta) {
        fullText += delta;
        onChunk?.(delta);
      }
      if (chunk.usage) {
        tokensIn = chunk.usage.prompt_tokens;
        tokensOut = chunk.usage.completion_tokens;
      }
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
    onChunk?: (chunk: string) => void
  ): Promise<SummaryResult> {
    const start = Date.now();
    const prompt = buildSummaryPrompt(question, sql, results);

    const stream = await this.client.chat.completions.create({
      model: this.modelName,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      stream_options: { include_usage: true },
    });

    let fullText = '';
    let tokensIn = 0;
    let tokensOut = 0;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? '';
      if (delta) {
        fullText += delta;
        onChunk?.(delta);
      }
      if (chunk.usage) {
        tokensIn = chunk.usage.prompt_tokens;
        tokensOut = chunk.usage.completion_tokens;
      }
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
      await this.client.chat.completions.create({
        model: this.modelName,
        messages: [{ role: 'user', content: 'Reply with only: OK' }],
        max_tokens: 5,
      });
      return true;
    } catch {
      return false;
    }
  }
}
