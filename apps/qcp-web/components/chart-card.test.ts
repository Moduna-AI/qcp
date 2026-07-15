import { describe, expect, test } from "bun:test";
import { chartColor, formatChartValue, QCP_CHART_COLORS } from "./chart-card";

describe("qcp chart presentation helpers", () => {
	test("assigns deterministic series colors", () => {
		expect(chartColor(0)).toBe(QCP_CHART_COLORS[0]);
		expect(chartColor(QCP_CHART_COLORS.length)).toBe(QCP_CHART_COLORS[0]);
		expect(chartColor(5)).toBe(chartColor(5));
	});

	test("formats tooltip values without losing categories or null gaps", () => {
		expect(formatChartValue(1234.56789)).toBe("1,234.5679");
		expect(formatChartValue("2026-07-15")).toBe("2026-07-15");
		expect(formatChartValue(null)).toBe("No value");
	});
});
