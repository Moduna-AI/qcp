import chalk from "chalk";
import { loadConfig, saveConfig } from "@/config/index.js";
import { printSection, printSuccess } from "@/output/index.js";

export function telemetryOnCommand(): void {
	const config = loadConfig();
	saveConfig({ ...config, telemetry: true });
	printSuccess("Telemetry enabled");
}

export function telemetryOffCommand(): void {
	const config = loadConfig();
	saveConfig({ ...config, telemetry: false });
	printSuccess("Telemetry disabled");
}

export function telemetryStatusCommand(): void {
	const config = loadConfig();

	console.log();
	printSection("Telemetry Status");

	const status = config.telemetry
		? chalk.green("● enabled")
		: chalk.dim("○ disabled");
	console.log(`  Status: ${status}`);

	console.log(`\n  Install ID: ${chalk.dim(config.installId)}`);

	console.log("\n  What is collected:");
	const collected = [
		"qcp version",
		"Operating system and architecture",
		"Command usage (which commands you run)",
		"Error events (type of error, not the content)",
	];
	for (const item of collected) {
		console.log(`    ${chalk.green("✓")} ${chalk.dim(item)}`);
	}

	console.log("\n  What is NEVER collected:");
	const neverCollected = [
		"SQL queries or query results",
		"Database URLs or connection strings",
		"Schema metadata (table or column names)",
		"API keys or credentials",
		"Row data from your database",
	];
	for (const item of neverCollected) {
		console.log(`    ${chalk.red("✗")} ${chalk.dim(item)}`);
	}

	console.log();
	if (config.telemetry) {
		console.log(chalk.dim("  Disable with: qcp telemetry off"));
	} else {
		console.log(chalk.dim("  Enable with: qcp telemetry on"));
	}
}
