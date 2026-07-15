import type { ToolsInput } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { sanitizeSensitiveData } from "@/safety/index.js";
import {
	type QcpChartInput,
	type QcpChartResult,
	type QcpChartSpec,
	qcpChartInputSchema,
	qcpChartResultSchema,
	qcpChartSpecSchema,
} from "@/types/chart.js";

export const QCP_CHART_TOOL_ID = "qcp_render_chart";

export function createChartTools(): ToolsInput {
	return {
		[QCP_CHART_TOOL_ID]: createTool({
			id: QCP_CHART_TOOL_ID,
			description:
				"Render one chart in qcp-web from rows already returned by qcp_execute_read_sql. Use only for meaningful trends, comparisons, or distributions. Never calculate, aggregate, invent, or query data in this tool.",
			strict: true,
			inputSchema: qcpChartInputSchema,
			outputSchema: qcpChartResultSchema,
			toModelOutput: (output) => ({
				type: "json",
				value: output.ok
					? { ok: true, chartRendered: true }
					: { ok: false, error: output.error },
			}),
			transform: {
				display: {
					input: ({ input }) => summarizeChartInput(input),
					output: ({ output }) => sanitizeSensitiveData(output),
					error: () => ({ message: "Chart rendering failed." }),
				},
				transcript: {
					input: ({ input }) => summarizeChartInput(input),
					output: ({ output }) => sanitizeSensitiveData(output),
					error: () => ({ message: "Chart rendering failed." }),
				},
			},
			mcp: {
				annotations: {
					title: "Render Chart",
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: false,
				},
			},
			execute: async (input) => normalizeChartSpec(input),
		}),
	};
}

export function normalizeChartSpec(input: QcpChartInput): QcpChartResult {
	if (input.version !== 1) {
		return chartError("Unsupported chart specification version.");
	}
	const uniqueSeriesKeys = new Set(input.series.map((series) => series.key));
	if (uniqueSeriesKeys.size !== input.series.length) {
		return chartError("Chart series keys must be unique.");
	}
	if (uniqueSeriesKeys.has(input.xKey)) {
		return chartError("The x-axis key cannot also be a numeric series key.");
	}
	if (input.type === "pie" && input.series.length !== 1) {
		return chartError(
			"Pie and donut charts require exactly one numeric series.",
		);
	}
	if (input.type !== "pie" && input.variant !== undefined) {
		return chartError("The pie/donut variant is only valid for pie charts.");
	}

	const normalizedRows: QcpChartSpec["data"] = [];
	for (const [rowIndex, row] of input.data.entries()) {
		const normalized = normalizeChartRow(input, row, rowIndex);
		if (!normalized.ok) return normalized;
		normalizedRows.push(normalized.row);
	}

	if (
		input.type === "pie" &&
		!normalizedRows.some((row) => {
			const value = row[input.series[0]?.key ?? ""];
			return typeof value === "number" && value > 0;
		})
	) {
		return chartError(
			"Pie and donut charts require at least one positive value.",
		);
	}

	const chart = sanitizeSensitiveData({
		...input,
		version: 1 as const,
		variant: input.type === "pie" ? (input.variant ?? "pie") : undefined,
		data: normalizedRows,
	});
	const parsed = qcpChartSpecSchema.safeParse(chart);
	return parsed.success
		? { ok: true, chart: parsed.data }
		: chartError("The normalized chart did not match the chart schema.");
}

function normalizeChartRow(
	input: QcpChartInput,
	row: Record<string, string | number | null>,
	rowIndex: number,
):
	| { readonly ok: true; readonly row: Record<string, string | number | null> }
	| { readonly ok: false; readonly error: string } {
	const xValue = row[input.xKey];
	if (xValue === undefined || xValue === null) {
		return chartError(
			`Row ${rowIndex + 1} is missing x-axis value ${input.xKey}.`,
		);
	}

	const normalizedRow: Record<string, string | number | null> = {
		[input.xKey]: xValue,
	};
	if (input.type === "scatter") {
		const numericX = toFiniteNumber(xValue);
		if (numericX === undefined) {
			return chartError(`Scatter x-axis value ${input.xKey} must be numeric.`);
		}
		normalizedRow[input.xKey] = numericX;
	} else if (typeof xValue === "number" && !Number.isFinite(xValue)) {
		return chartError(
			`Row ${rowIndex + 1} contains a non-finite x-axis value.`,
		);
	}

	for (const series of input.series) {
		const value = row[series.key];
		if (value === undefined) {
			return chartError(
				`Row ${rowIndex + 1} is missing series value ${series.key}.`,
			);
		}
		if (value === null) {
			if (input.type === "pie" || input.type === "scatter") {
				return chartError(
					`${input.type} charts cannot contain null values for ${series.key}.`,
				);
			}
			normalizedRow[series.key] = null;
			continue;
		}

		const numericValue = toFiniteNumber(value);
		if (numericValue === undefined) {
			return chartError(
				`Series ${series.key} must contain only numeric values.`,
			);
		}
		if (input.type === "pie" && numericValue < 0) {
			return chartError("Pie and donut chart values cannot be negative.");
		}
		normalizedRow[series.key] = numericValue;
	}

	return { ok: true, row: normalizedRow };
}

function toFiniteNumber(value: string | number): number | undefined {
	if (typeof value === "number")
		return Number.isFinite(value) ? value : undefined;
	const normalized = value.trim();
	if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) {
		return undefined;
	}
	const numericValue = Number(normalized);
	return Number.isFinite(numericValue) ? numericValue : undefined;
}

function chartError(error: string): {
	readonly ok: false;
	readonly error: string;
} {
	return { ok: false, error };
}

function summarizeChartInput(input: unknown): Record<string, unknown> {
	const parsed = qcpChartInputSchema.safeParse(input);
	if (!parsed.success) return { chart: "[INVALID_CHART_SPEC]" };
	return {
		type: parsed.data.type,
		title: sanitizeSensitiveData(parsed.data.title),
		pointCount: parsed.data.data.length,
		seriesCount: parsed.data.series.length,
	};
}
