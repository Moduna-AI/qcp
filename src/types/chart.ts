import { z } from "zod";

export const qcpChartSeriesSchema = z.object({
	key: z.string().min(1),
	label: z.string().min(1),
});

const chartValueSchema = z.union([z.string(), z.number(), z.null()]);
const chartRowSchema = z.record(z.string(), chartValueSchema);

export const qcpChartInputSchema = z.object({
	version: z.number().int().min(1).max(1).default(1),
	type: z.enum(["bar", "line", "area", "pie", "scatter"]),
	title: z.string().trim().min(1).max(160),
	xKey: z.string().min(1),
	xAxisLabel: z.string().trim().min(1).max(80).optional(),
	yAxisLabel: z.string().trim().min(1).max(80).optional(),
	variant: z.enum(["pie", "donut"]).optional(),
	series: z.array(qcpChartSeriesSchema).min(1).max(8),
	data: z.array(chartRowSchema).min(1).max(250),
});

export const qcpChartSpecSchema = qcpChartInputSchema.extend({
	version: z.literal(1),
	data: z.array(chartRowSchema).min(1).max(250),
});

export type QcpChartInput = z.infer<typeof qcpChartInputSchema>;
export type QcpChartSpec = z.infer<typeof qcpChartSpecSchema>;

export const qcpChartResultSchema = z.discriminatedUnion("ok", [
	z.object({
		ok: z.literal(true),
		chart: qcpChartSpecSchema,
	}),
	z.object({
		ok: z.literal(false),
		error: z.string(),
	}),
]);

export type QcpChartResult = z.infer<typeof qcpChartResultSchema>;
