import chalk from "chalk";
import ora from "ora";
import { getDatabaseUrl, loadConfig, saveConfig } from "../config/index.js";
import { checkReadOnlyUser, testConnection } from "../db/index.js";
import { log } from "../logger/index.js";
import {
	printError,
	printInfo,
	printSuccess,
	printWarning,
} from "../output/index.js";

export async function connectCommand(databaseUrl?: string): Promise<void> {
	const config = loadConfig();

	// Use provided URL, or fall back to current config / env
	const url = databaseUrl ?? getDatabaseUrl(config);

	if (!url) {
		printError(
			"No database URL provided.",
			"Usage: qcp connect postgres://user:pass@host:5432/dbname\n" +
				"Or set the QCP_DATABASE_URL environment variable.",
		);
		process.exit(1);
	}

	const spinner = ora("Testing connection...").start();

	try {
		const result = await testConnection(url);

		if (!result.connected) {
			spinner.fail("Connection failed");
			printError(result.error ?? "Unknown connection error");
			console.log();
			printInfo("Common fixes:");
			console.log(
				chalk.dim("  • Check the database host and port are reachable"),
			);
			console.log(
				chalk.dim("  • Verify the username and password are correct"),
			);
			console.log(chalk.dim("  • Ensure the database name exists"));
			console.log(chalk.dim("  • Check firewall rules and pg_hba.conf"));
			process.exit(1);
		}

		spinner.succeed(`Connected to ${result.version}`);

		// Save URL to config
		saveConfig({ ...config, databaseUrl: url });

		// Check read-only permissions
		const readOnlySpinner = ora("Checking permissions...").start();
		const isReadOnly = await checkReadOnlyUser(url);

		if (isReadOnly) {
			readOnlySpinner.succeed("Read-only user verified");
		} else {
			readOnlySpinner.warn("User has write permissions");
			printWarning(
				"The connected user has write permissions. qcp enforces read-only at the " +
					"SQL level, but for maximum safety, consider creating a dedicated read-only role:\n\n" +
					chalk.dim("  CREATE ROLE qcp_readonly;\n") +
					chalk.dim("  GRANT CONNECT ON DATABASE mydb TO qcp_readonly;\n") +
					chalk.dim("  GRANT USAGE ON SCHEMA public TO qcp_readonly;\n") +
					chalk.dim(
						"  GRANT SELECT ON ALL TABLES IN SCHEMA public TO qcp_readonly;\n",
					) +
					chalk.dim(
						"  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO qcp_readonly;",
					),
			);
		}

		printSuccess("Database connection saved");
		printInfo("Run `qcp schema scan` to index your database schema");

		log("info", "Database connected", { version: result.version });
	} catch (err: unknown) {
		spinner.fail("Connection test failed");
		const message = err instanceof Error ? err.message : String(err);
		printError(message);
		log("error", "Connection failed", { error: message });
		process.exit(1);
	}
}

export async function showConnectionStatus(): Promise<void> {
	const config = loadConfig();
	const url = getDatabaseUrl(config);

	if (!url) {
		printInfo("No database connection configured.");
		printInfo("Run: qcp connect postgres://user:pass@host/db");
		return;
	}

	const spinner = ora("Checking connection...").start();
	const result = await testConnection(url);

	if (result.connected) {
		spinner.succeed(`Connected: ${result.version}`);
	} else {
		spinner.fail(`Connection lost: ${result.error}`);
	}
}
