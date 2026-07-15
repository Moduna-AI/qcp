"use client";

import { memo, useMemo } from "react";
import {
	Area,
	AreaChart,
	Bar,
	BarChart,
	CartesianGrid,
	Cell,
	Legend,
	Line,
	LineChart,
	Pie,
	PieChart,
	ResponsiveContainer,
	Scatter,
	ScatterChart,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import type { QcpChartSpec } from "~/lib/chart-contract";

export const QCP_CHART_COLORS = [
	"#7dd3fc",
	"#a78bfa",
	"#34d399",
	"#fbbf24",
	"#fb7185",
	"#22d3ee",
	"#c084fc",
	"#f97316",
] as const;

const CHART_TOOLTIP_CONTENT_STYLE = {
	borderColor: "var(--line)",
	borderRadius: 6,
	background: "var(--panel-2)",
};

const CHART_TOOLTIP_LABEL_STYLE = {
	color: "var(--soft)",
};

interface ChartCardProps {
	readonly chart: QcpChartSpec;
}

export const ChartCard = memo(function ChartCard({
	chart,
}: ChartCardProps): React.ReactElement {
	const data = useMemo(
		() => chart.data.map((row) => ({ ...row })),
		[chart.data],
	);
	const ariaLabel = `${chart.title}. ${chart.type} chart with ${chart.data.length} data points.`;

	return (
		<section aria-label={ariaLabel} className="chart-card">
			<h3>{chart.title}</h3>
			<div className="chart-frame">
				<ResponsiveContainer height="100%" width="100%">
					{renderChart(chart, data)}
				</ResponsiveContainer>
			</div>
		</section>
	);
});

function renderChart(
	chart: QcpChartSpec,
	data: Array<Record<string, string | number | null>>,
): React.ReactElement {
	switch (chart.type) {
		case "bar":
			return (
				<BarChart accessibilityLayer data={data}>
					<CartesianGrid strokeDasharray="3 3" vertical={false} />
					{renderAxes(chart)}
					<Tooltip
						contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
						formatter={(value) => formatChartValue(value)}
						labelStyle={CHART_TOOLTIP_LABEL_STYLE}
					/>
					<Legend />
					{chart.series.map((series, index) => (
						<Bar
							dataKey={series.key}
							fill={chartColor(index)}
							isAnimationActive={false}
							key={series.key}
							name={series.label}
							radius={[4, 4, 0, 0]}
						/>
					))}
				</BarChart>
			);
		case "line":
			return (
				<LineChart accessibilityLayer data={data}>
					<CartesianGrid strokeDasharray="3 3" vertical={false} />
					{renderAxes(chart)}
					<Tooltip
						contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
						formatter={(value) => formatChartValue(value)}
						labelStyle={CHART_TOOLTIP_LABEL_STYLE}
					/>
					<Legend />
					{chart.series.map((series, index) => (
						<Line
							connectNulls={false}
							dataKey={series.key}
							dot={data.length <= 40}
							isAnimationActive={false}
							key={series.key}
							name={series.label}
							stroke={chartColor(index)}
							strokeWidth={2}
							type="monotone"
						/>
					))}
				</LineChart>
			);
		case "area":
			return (
				<AreaChart accessibilityLayer data={data}>
					<CartesianGrid strokeDasharray="3 3" vertical={false} />
					{renderAxes(chart)}
					<Tooltip
						contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
						formatter={(value) => formatChartValue(value)}
						labelStyle={CHART_TOOLTIP_LABEL_STYLE}
					/>
					<Legend />
					{chart.series.map((series, index) => (
						<Area
							connectNulls={false}
							dataKey={series.key}
							fill={chartColor(index)}
							fillOpacity={0.22}
							isAnimationActive={false}
							key={series.key}
							name={series.label}
							stroke={chartColor(index)}
							strokeWidth={2}
							type="monotone"
						/>
					))}
				</AreaChart>
			);
		case "pie": {
			const series = chart.series[0];
			return (
				<PieChart accessibilityLayer>
					<Tooltip
						contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
						formatter={(value) => formatChartValue(value)}
						labelStyle={CHART_TOOLTIP_LABEL_STYLE}
					/>
					<Legend />
					<Pie
						data={data}
						dataKey={series?.key ?? ""}
						innerRadius={chart.variant === "donut" ? "48%" : 0}
						isAnimationActive={false}
						nameKey={chart.xKey}
						outerRadius="82%"
					>
						{data.map((row, index) => (
							<Cell
								fill={chartColor(index)}
								key={`${String(row[chart.xKey])}-${index.toString()}`}
							/>
						))}
					</Pie>
				</PieChart>
			);
		}
		case "scatter":
			return (
				<ScatterChart accessibilityLayer>
					<CartesianGrid strokeDasharray="3 3" />
					<XAxis
						dataKey="x"
						label={axisLabel(chart.xAxisLabel, "insideBottom", 0)}
						name={chart.xAxisLabel ?? chart.xKey}
						type="number"
					/>
					<YAxis
						dataKey="y"
						label={axisLabel(chart.yAxisLabel, "insideLeft", -90)}
						name={chart.yAxisLabel ?? "Value"}
						type="number"
					/>
					<Tooltip
						contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
						cursor={{ strokeDasharray: "3 3" }}
						labelStyle={CHART_TOOLTIP_LABEL_STYLE}
					/>
					<Legend />
					{chart.series.map((series, index) => (
						<Scatter
							data={data.map((row) => ({
								x: row[chart.xKey],
								y: row[series.key],
							}))}
							fill={chartColor(index)}
							isAnimationActive={false}
							key={series.key}
							name={series.label}
						/>
					))}
				</ScatterChart>
			);
	}
}

function renderAxes(chart: QcpChartSpec): React.ReactElement {
	return (
		<>
			<XAxis
				dataKey={chart.xKey}
				label={axisLabel(chart.xAxisLabel, "insideBottom", 0)}
				minTickGap={16}
				tickFormatter={(value) => formatChartValue(value)}
			/>
			<YAxis
				label={axisLabel(chart.yAxisLabel, "insideLeft", -90)}
				tickFormatter={(value) => formatChartValue(value)}
			/>
		</>
	);
}

function axisLabel(
	value: string | undefined,
	position: "insideBottom" | "insideLeft",
	angle: number,
): { value: string; position: typeof position; angle: number } | undefined {
	return value ? { value, position, angle } : undefined;
}

export function chartColor(index: number): string {
	return QCP_CHART_COLORS[index % QCP_CHART_COLORS.length] ?? "#7dd3fc";
}

export function formatChartValue(value: unknown): string {
	if (typeof value === "number") {
		return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(
			value,
		);
	}
	if (typeof value === "string") return value;
	return value == null ? "No value" : String(value);
}
