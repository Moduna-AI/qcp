import chalk from "chalk";
import Table from "cli-table3";
import type {
	ApprovalReason,
	QueryMetrics,
	QueryResult,
	SafetyReport,
} from "@/types/index.js";

// ─── Branding ─────────────────────────────────────────────────────────────────

export function printBanner(): void {
	console.log(chalk.bold.cyan("\n  ◆ qcp") + chalk.dim(" — Query Companion\n"));
}

// ─── Question / Answer flow ───────────────────────────────────────────────────

export function printQuestion(question: string): void {
	console.log(chalk.bold("\nQuestion:"));
	console.log(chalk.white(`  ${question}`));
}

export function printSql(sql: string): void {
	console.log(chalk.bold("\nGenerated SQL:"));
	const lines = sql.split("\n");
	for (const line of lines) {
		console.log(chalk.cyan(`  ${line}`));
	}
}

export function printExplanation(explanation: string): void {
	if (!explanation.trim()) return;
	console.log(chalk.bold("\nExplanation:"));
	console.log(chalk.white(`  ${explanation.replace(/\n/g, "\n  ")}`));
}

export function printSummary(summary: string): void {
	console.log(chalk.bold("\nInsight:"));
	console.log(chalk.white(`  ${summary.replace(/\n/g, "\n  ")}`));
}

// ─── Safety report ────────────────────────────────────────────────────────────

export function printSafetyReport(report: SafetyReport): void {
	console.log(chalk.bold("\nSafety:"));

	const tick = chalk.green("  ✓");
	const cross = chalk.red("  ✗");

	console.log(
		report.readOnly
			? `${tick} Read-only connection`
			: `${cross} Read-only connection`,
	);

	console.log(
		report.allowedStatement
			? `${tick} SELECT-only query`
			: `${cross} SELECT-only query`,
	);

	console.log(
		report.limitApplied
			? `${tick} LIMIT applied (100)`
			: `${chalk.green("  ✓")} LIMIT already present`,
	);

	if (report.safe) {
		console.log(`${tick} Query validated`);
	} else {
		console.log(`${cross} Query rejected`);
	}

	if (report.errors.length > 0) {
		console.log();
		for (const err of report.errors) {
			console.log(chalk.red(`  ✗ ${err}`));
		}
	}

	if (report.warnings.length > 0) {
		for (const warn of report.warnings) {
			console.log(chalk.yellow(`  ⚠ ${warn}`));
		}
	}
}

// ─── Results table ────────────────────────────────────────────────────────────

export function printResults(result: QueryResult): void {
	if (result.rowCount === 0) {
		console.log(chalk.yellow("\n  No results found."));
		return;
	}

	console.log(chalk.bold("\nResults:"));

	const table = new Table({
		head: result.fields.map((f) => chalk.cyan(f)),
		style: {
			head: [],
			border: ["grey"],
			compact: false,
		},
		wordWrap: true,
	});

	for (const row of result.rows) {
		table.push(
			result.fields.map((f) => {
				const val = row[f];
				if (val === null || val === undefined) return chalk.dim("NULL");
				if (val instanceof Date)
					return val.toISOString().replace("T", " ").slice(0, 19);
				const str = String(val);
				// Truncate very long strings
				return str.length > 80 ? `${str.slice(0, 77)}…` : str;
			}),
		);
	}

	console.log(table.toString());
	console.log(
		chalk.dim(`  ${result.rowCount} row(s)`) +
			chalk.dim(` · ${result.executionTimeMs}ms`),
	);
}

// ─── Approval prompt ──────────────────────────────────────────────────────────

export function printApprovalWarning(reasons: ApprovalReason[]): void {
	console.log(chalk.yellow.bold("\n⚠  Potentially sensitive query detected"));
	console.log(chalk.yellow("   Reasons:"));
	for (const reason of reasons) {
		console.log(chalk.yellow(`   • ${reason.detail}`));
	}
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

export function printMetrics(metrics: QueryMetrics): void {
	console.log(chalk.bold("\nMetrics:"));
	console.log(chalk.dim(`  Provider:      `) + chalk.white(metrics.provider));
	console.log(chalk.dim(`  Model:         `) + chalk.white(metrics.model));
	console.log(
		chalk.dim(`  Tokens in:     `) + chalk.white(String(metrics.tokensIn)),
	);
	console.log(
		chalk.dim(`  Tokens out:    `) + chalk.white(String(metrics.tokensOut)),
	);
	console.log(
		chalk.dim(`  SQL gen:       `) +
			chalk.white(`${metrics.sqlGenerationMs}ms`),
	);
	console.log(
		chalk.dim(`  Execution:     `) + chalk.white(`${metrics.executionMs}ms`),
	);
	console.log(
		chalk.dim(`  Summary:       `) + chalk.white(`${metrics.summaryMs}ms`),
	);
	console.log(
		chalk.dim(`  Total:         `) + chalk.white(`${metrics.totalLatencyMs}ms`),
	);
}

// ─── Error / Success helpers ──────────────────────────────────────────────────

export function printError(message: string, detail?: string): void {
	console.error(chalk.red("\n  ✗ Error: ") + chalk.white(message));
	if (detail) {
		console.error(chalk.dim("    " + detail.replace(/\n/g, "\n    ")));
	}
}

export function printSuccess(message: string): void {
	console.log(chalk.green("\n  ✓ ") + message);
}

export function printInfo(message: string): void {
	console.log(chalk.dim("  · ") + chalk.white(message));
}

export function printWarning(message: string): void {
	console.log(chalk.yellow("  ⚠ ") + message);
}

// ─── Doctor output ────────────────────────────────────────────────────────────

export function printDoctorCheck(
	name: string,
	status: "healthy" | "warning" | "error" | "unknown",
	value?: string,
): void {
	const icons = {
		healthy: chalk.green("  ✓"),
		warning: chalk.yellow("  ⚠"),
		error: chalk.red("  ✗"),
		unknown: chalk.dim("  ?"),
	};
	const icon = icons[status];
	const text = value ? `${name}: ${chalk.bold(value)}` : name;
	console.log(`${icon} ${text}`);
}

// ─── Section headers ──────────────────────────────────────────────────────────

export function printSection(title: string): void {
	console.log("\n" + chalk.bold.white(title + ":"));
}
