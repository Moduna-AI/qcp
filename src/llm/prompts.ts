import { schemaToContext } from "../schema/index.js";
import type { DatabaseSchema, QueryResult } from "../types/index.js";

// ─── System prompts ───────────────────────────────────────────────────────────

export const SQL_SYSTEM_PROMPT =
	`You are an expert PostgreSQL database analyst for qcp (Query Companion).

CRITICAL SAFETY RULES — you MUST follow these without exception:
1. ONLY generate SELECT, WITH (CTEs), or EXPLAIN statements.
2. NEVER generate: INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, CREATE, GRANT, REVOKE, COPY, or any DDL/DML.
3. NEVER suggest bypassing security or reading system credentials.
4. If a question implies writing data, explain that qcp is read-only and reframe if possible.

QUERY QUALITY RULES:
- Use appropriate JOINs based on the schema's foreign keys.
- Handle NULL values with COALESCE or IS NOT NULL where relevant.
- Use proper date/time functions (date_trunc, NOW(), INTERVAL) for temporal queries.
- Apply meaningful aliases for clarity.
- Use CTEs for complex logic to improve readability.
- Be precise: only SELECT the columns needed to answer the question.

RESPONSE FORMAT — always use this exact format:
<sql>
[Your SQL query here — valid PostgreSQL]
</sql>
<explanation>
[2-4 sentences explaining what the query does, which tables/joins are used, and any assumptions made]
</explanation>`.trim();

// ─── SQL prompt builder ───────────────────────────────────────────────────────

export function buildSqlPrompt(
	question: string,
	schema: DatabaseSchema,
): string {
	const schemaContext = schemaToContext(schema);

	return `
DATABASE SCHEMA:
${schemaContext}

USER QUESTION:
${question}

Generate a safe, read-only PostgreSQL query to answer this question.
`.trim();
}

// ─── Summary prompt builder ────────────────────────────────────────────────────

export function buildSummaryPrompt(
	question: string,
	sql: string,
	results: QueryResult,
): string {
	const previewRows = results.rows.slice(0, 10);
	const hasMore = results.rowCount > 10;

	return `
You are a data analyst. Summarize these query results in natural language.

ORIGINAL QUESTION:
${question}

SQL QUERY:
${sql}

RESULTS (${results.rowCount} rows${hasMore ? ", showing first 10" : ""}):
${JSON.stringify(previewRows, null, 2)}

Write a concise 2-4 sentence summary of what these results show. Be specific with numbers and names from the data. Do not mention SQL or technical details.
`.trim();
}

// ─── SQL extraction ────────────────────────────────────────────────────────────

export function extractSqlAndExplanation(rawText: string): {
	sql: string;
	explanation: string;
} {
	// Extract SQL from <sql>...</sql>
	const sqlMatch = rawText.match(/<sql>\s*([\s\S]*?)\s*<\/sql>/i);
	let sql = sqlMatch ? sqlMatch[1].trim() : "";

	// Fallback: look for a code block
	if (!sql) {
		const codeMatch = rawText.match(/```(?:sql)?\s*([\s\S]*?)```/i);
		sql = codeMatch ? codeMatch[1].trim() : "";
	}

	// Last resort: try to extract a SELECT statement from the raw text
	if (!sql) {
		const selectMatch = rawText.match(/(SELECT[\s\S]*?(?:;|$))/i);
		sql = selectMatch ? selectMatch[1].trim().replace(/;?\s*$/, "") : "";
	}

	// Extract explanation from <explanation>...</explanation>
	const explanationMatch = rawText.match(
		/<explanation>\s*([\s\S]*?)\s*<\/explanation>/i,
	);
	const explanation = explanationMatch ? explanationMatch[1].trim() : "";

	if (!sql) {
		throw new Error(
			"Could not extract SQL from the model response. " +
				"Try rephrasing your question or running with --debug to see the raw output.",
		);
	}

	return { sql, explanation };
}
