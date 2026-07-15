import { describe, expect, test } from "bun:test";
import { parseJsonEventStream, uiMessageChunkSchema } from "ai";
import { extractChartResults, streamDirectText } from "./chat-runs";

describe("qcp-web AI SDK stream adapter", () => {
	test("keeps direct text readable as typed UI message chunks", async () => {
		const response = streamDirectText("Connected to Chinook.");
		const chunks = await readChunks(response);

		expect(chunks).toContainEqual({
			type: "text-delta",
			id: "qcp-direct-text",
			delta: "Connected to Chinook.",
		});
		expect(chunks.at(-1)).toMatchObject({ type: "finish" });
	});

	test("extracts one validated nested chart without forwarding SQL payloads", () => {
		const nestedResult = {
			toolResults: [
				{
					toolName: "qcp_execute_read_sql",
					toolCallId: "sql-1",
					args: { sql: "SELECT secret FROM customers" },
					result: { rows: [{ secret: "do-not-forward" }] },
				},
			],
			steps: [
				{
					toolResults: [
						{
							toolName: "qcp_render_chart",
							toolCallId: "chart-1",
							result: {
								ok: true,
								chart: {
									version: 1,
									type: "bar",
									title: "Tracks by genre",
									xKey: "genre",
									series: [{ key: "tracks", label: "Tracks" }],
									data: [{ genre: "Rock", tracks: 100 }],
								},
							},
						},
					],
				},
			],
		};

		const charts = extractChartResults(nestedResult);

		expect(charts).toHaveLength(1);
		expect(charts[0]?.toolCallId).toBe("chart-1");
		expect(JSON.stringify(charts)).not.toContain("SELECT");
		expect(JSON.stringify(charts)).not.toContain("do-not-forward");
	});

	test("drops invalid or failed nested chart results", () => {
		expect(
			extractChartResults({
				toolResults: [
					{
						toolName: "qcp_render_chart",
						result: { ok: false, error: "invalid data" },
					},
					{
						toolName: "qcp_render_chart",
						result: { ok: true, chart: { type: "heatmap" } },
					},
				],
			}),
		).toEqual([]);
	});
});

async function readChunks(response: Response): Promise<unknown[]> {
	if (!response.body) throw new Error("Expected an AI SDK response stream.");
	const chunks: unknown[] = [];
	const parsed = parseJsonEventStream({
		stream: response.body,
		schema: uiMessageChunkSchema,
	});
	for await (const result of parsed) {
		if (!result.success) throw result.error;
		chunks.push(result.value);
	}
	return chunks;
}
