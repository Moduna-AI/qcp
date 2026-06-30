import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isatty } from "node:tty";
import chalk from "chalk";
import inquirer from "inquirer";
import {
	configExists,
	createDefaultConfig,
	ensureConfigDir,
	LOCAL_QCP_DIR,
	LOCAL_SCHEMA_CATALOG_PATH,
	saveConfig,
} from "@/config/index.js";
import {
	printBanner,
	printInfo,
	printSuccess,
	printWarning,
} from "@/output/index.js";
import {
	initTelemetry,
	shutdownTelemetry,
	trackInstall,
} from "@/telemetry/index.js";
import { QCP_VERSION } from "@/version.js";

export async function initCommand(): Promise<void> {
	printBanner();

	// ── Create global ~/.qcp config ───────────────────────────────────────────
	ensureConfigDir();

	const isFirstRun = !configExists();
	let config = createDefaultConfig();

	if (isFirstRun) {
		console.log(chalk.bold("Welcome to qcp — Query Companion!\n"));
		console.log(chalk.dim("Setting up your configuration...\n"));

		// Telemetry consent prompt (only in interactive TTY to avoid CI blocking)
		let telemetryEnabled = true;

		if (isatty(process.stdin.fd as number)) {
			console.log(chalk.cyan("qcp collects anonymous usage telemetry."));
			console.log(chalk.dim("Collected:"));
			console.log(chalk.dim("  • qcp version, OS, CPU architecture"));
			console.log(chalk.dim("  • Command usage and error events"));
			console.log(chalk.dim("Never collected:"));
			console.log(chalk.dim("  • SQL queries or query results"));
			console.log(chalk.dim("  • Database URLs or credentials"));
			console.log(chalk.dim("  • Schema metadata or API keys\n"));

			const { consent } = await inquirer.prompt([
				{
					type: "confirm",
					name: "consent",
					message: "Enable anonymous telemetry?",
					default: true,
				},
			]);
			telemetryEnabled = consent;
		}

		config = saveConfig({ ...config, telemetry: telemetryEnabled });

		// Track install event
		initTelemetry(config);
		trackInstall();
		await shutdownTelemetry();

		printSuccess(`qcp ${QCP_VERSION} initialized`);
		printInfo(`Config saved to ~/.qcp/config.json`);

		if (!telemetryEnabled) {
			printInfo("Telemetry disabled. You can re-enable with: qcp telemetry on");
		}
	} else {
		config = saveConfig({});
		printInfo("Global config already exists — skipping setup.");
	}

	// ── Create local .qcp/ project directory ─────────────────────────────────
	const alreadyHasLocal = existsSync(LOCAL_QCP_DIR);

	if (!alreadyHasLocal) {
		mkdirSync(LOCAL_QCP_DIR, { recursive: true });

		// Create a stub schemas.json so the path is predictable
		if (!existsSync(LOCAL_SCHEMA_CATALOG_PATH)) {
			writeFileSync(
				LOCAL_SCHEMA_CATALOG_PATH,
				JSON.stringify({ version: "1", schemas: [] }, null, 2),
			);
		}

		printSuccess("Created .qcp/ project directory");
		printInfo(
			"Run `qcp connect --name default` to add your database connection",
		);
		printInfo("Run `qcp schema scan` to scan your database schema");
	} else {
		printInfo(".qcp/ project directory already exists");
	}

	// ── .gitignore advice ─────────────────────────────────────────────────────
	const gitignorePath = ".gitignore";
	if (existsSync(gitignorePath)) {
		const { default: fs } = await import("node:fs");
		const existing = fs.readFileSync(gitignorePath, "utf-8");
		if (!existing.includes(".qcp/")) {
			printWarning(
				"Consider adding .qcp/ to your .gitignore to avoid committing schema data.",
			);
		}
	}

	console.log();
	console.log(chalk.bold("Next steps:"));
	console.log(chalk.dim("  1. ") + chalk.white("qcp connect"));
	console.log(chalk.dim("  2. ") + chalk.white("qcp db list"));
	console.log(
		chalk.dim("  3. ") +
			chalk.white('qcp ask "What were our top customers last month?"'),
	);
	console.log();
}
