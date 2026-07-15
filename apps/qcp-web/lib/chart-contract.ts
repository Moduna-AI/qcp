import type { QcpChartSpec } from "@moduna/qcp/web";
import { z } from "zod";

const chartSeriesSchema = z.object({
	key: z.string().min(1),
	label: z.string().min(1),
});

const chartValueSchema = z.union([z.string(), z.number(), z.null()]);
const chartRowSchema = z.record(z.string(), chartValueSchema);

export const qcpWebChartSpecSchema = z.object({
	version: z.literal(1),
	type: z.enum(["bar", "line", "area", "pie", "scatter"]),
	title: z.string().trim().min(1).max(160),
	xKey: z.string().min(1),
	xAxisLabel: z.string().trim().min(1).max(80).optional(),
	yAxisLabel: z.string().trim().min(1).max(80).optional(),
	variant: z.enum(["pie", "donut"]).optional(),
	series: z.array(chartSeriesSchema).min(1).max(8),
	data: z.array(chartRowSchema).min(1).max(250),
}) satisfies z.ZodType<QcpChartSpec>;

export const qcpWebChartResultSchema = z.discriminatedUnion("ok", [
	z.object({
		ok: z.literal(true),
		chart: qcpWebChartSpecSchema,
	}),
	z.object({
		ok: z.literal(false),
		error: z.string(),
	}),
]);

export type { QcpChartSpec };
