import { describe, expect, test } from "bun:test";
import type { ToolsInput } from "@mastra/core/agent";
import type { ToolAction } from "@mastra/core/tools";
import type { QcpChartSpec } from "@/types/chart.js";
import {
	createChartTools,
	normalizeChartSpec,
	QCP_CHART_TOOL_ID,
} from "./chart-tools.js";

describe("qcp chart tool", () => {
	test.each([
		"bar",
		"line",
		"area",
	] as const)("normalizes finite numeric strings for %s charts and preserves gaps", (type) => {
		const result = normalizeChartSpec(
			chartSpec(type, [
				{ month: "2026-01-01", total: "12.5" },
				{ month: "2026-02-01", total: null },
			]),
		);

		expect(result).toEqual({
			ok: true,
			chart: {
				...chartSpec(type, [
					{ month: "2026-01-01", total: 12.5 },
					{ month: "2026-02-01", total: null },
				]),
			},
		});
	});

	test("supports pie and donut charts with one non-negative series", () => {
		const result = normalizeChartSpec({
			...chartSpec("pie", [
				{ month: "Rock", total: "42" },
				{ month: "Jazz", total: 8 },
			]),
			variant: "donut",
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.chart.variant).toBe("donut");
			expect(result.chart.data[0]?.total).toBe(42);
		}
	});

	test("requires finite numeric scatter coordinates", () => {
		const result = normalizeChartSpec(
			chartSpec("scatter", [
				{ month: "1.25", total: "3e2" },
				{ month: 2, total: 4 },
			]),
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.chart.data).toEqual([
				{ month: 1.25, total: 300 },
				{ month: 2, total: 4 },
			]);
		}
		expect(
			normalizeChartSpec(
				chartSpec("scatter", [{ month: "January", total: 1 }]),
			),
		).toEqual({
			ok: false,
			error: "Scatter x-axis value month must be numeric.",
		});
	});

	test("accepts the 250-row and eight-series boundaries without truncation", () => {
		const series = Array.from({ length: 8 }, (_, index) => ({
			key: `value${index}`,
			label: `Value ${index}`,
		}));
		const data = Array.from({ length: 250 }, (_, index) => ({
			category: `Category ${index}`,
			...Object.fromEntries(series.map((item) => [item.key, index])),
		}));
		const result = normalizeChartSpec({
			version: 1,
			type: "bar",
			title: "Boundary chart",
			xKey: "category",
			series,
			data,
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.chart.data).toHaveLength(250);
			expect(result.chart.series).toHaveLength(8);
		}
	});

	test("rejects ambiguous values and incomplete pie or scatter points", () => {
		expect(
			normalizeChartSpec(chartSpec("bar", [{ month: "Jan", total: "1,000" }])),
		).toEqual({
			ok: false,
			error: "Series total must contain only numeric values.",
		});
		expect(
			normalizeChartSpec(chartSpec("pie", [{ month: "Rock", total: -1 }])),
		).toEqual({
			ok: false,
			error: "Pie and donut chart values cannot be negative.",
		});
		expect(
			normalizeChartSpec(chartSpec("pie", [{ month: "Rock", total: null }])),
		).toEqual({
			ok: false,
			error: "pie charts cannot contain null values for total.",
		});
		expect(
			normalizeChartSpec(chartSpec("scatter", [{ month: 1, total: null }])),
		).toEqual({
			ok: false,
			error: "scatter charts cannot contain null values for total.",
		});
	});

	test("is strict, pure, and annotated as a closed-world read-only MCP tool", async () => {
		const tools = createChartTools();
		const tool = tools[QCP_CHART_TOOL_ID] as ToolAction<
			unknown,
			unknown,
			unknown,
			unknown
		>;

		expect(tool.strict).toBe(true);
		expect(tool.requireApproval).toBe(false);
		expect(tool.mcp?.annotations).toEqual({
			title: "Render Chart",
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
		expect(
			await executeTool(tools, chartSpec("line", [{ month: "Jan", total: 7 }])),
		).toMatchObject({ ok: true });
	});
});

function chartSpec(
	type: QcpChartSpec["type"],
	data: QcpChartSpec["data"],
): QcpChartSpec {
	return {
		version: 1,
		type,
		title: "Monthly totals",
		xKey: "month",
		xAxisLabel: "Month",
		yAxisLabel: "Total",
		series: [{ key: "total", label: "Total" }],
		data,
	};
}

async function executeTool(
	tools: ToolsInput,
	input: QcpChartSpec,
): Promise<unknown> {
	const tool = tools[QCP_CHART_TOOL_ID] as
		| ToolAction<unknown, unknown, unknown, unknown>
		| undefined;
	if (!tool?.execute) throw new Error("Chart tool is unavailable in the test.");
	return tool.execute(input, {} as never);
}
