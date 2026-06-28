import { isatty } from "node:tty";
import chalk from "chalk";
import inquirer from "inquirer";
import ora from "ora";
import {
	inferDatabaseType,
	isDatabaseType,
	getDatabaseUrl,
	loadConfig,
	saveConfig,
} from "@/config/index.js";
import { checkReadOnlyUser, testConnection } from "@/db/index.js";
import { log } from "@/logger/index.js";
import {
	printError,
	printInfo,
	printSuccess,
	printWarning,
} from "@/output/index.js";
import type { DatabaseType, QcpConfig } from "@/types/index.js";

export interface ConnectOptions {
	type?: string;
}

interface DatabaseTypeInfo {
	label: string;
	description: string;
	guidance: string[];
}

const DATABASE_TYPE_INFO: Record<DatabaseType, DatabaseTypeInfo> = {
	"prisma-postgres": {
		label: "Prisma Postgres",
		description: "Prisma-hosted PostgreSQL",
		guidance: [
			"Use the Prisma Postgres connection string from your Prisma dashboard.",
			"Both direct and pooled PostgreSQL URLs are supported.",
		],
	},
	neon: {
		label: "Neon",
		description: "Neon-hosted serverless PostgreSQL",
		guidance: [
			"Use a Neon connection string from your project branch.",
			"Pooled and direct PostgreSQL URLs are supported.",
		],
	},
	supabase: {
		label: "Supabase",
		description: "Supabase-hosted PostgreSQL",
		guidance: [
			"Use the database connection string from Supabase project settings.",
			"A read-only database role is recommended instead of a service-role key.",
		],
	},
	"oracle-postgres": {
		label: "Oracle PostgreSQL",
		description: "PostgreSQL-compatible database on Oracle infrastructure",
		guidance: [
			"Use a PostgreSQL-compatible connection string from Oracle infrastructure.",
			"Native Oracle DB connection strings are not supported by qcp.",
		],
	},
	"other-postgres": {
		label: "Other PostgreSQL",
		description: "Any standard PostgreSQL-compatible database",
		guidance: [
			"Use a standard PostgreSQL URL from your database provider.",
			"Example shape: postgres://readonly_user:password@host:5432/dbname",
		],
	},
};

export async function connectCommand(
	databaseUrl?: string,
	options: ConnectOptions = {},
): Promise<void> {
	const config = loadConfig();

	const selectedType = parseDatabaseTypeOption(options.type);
	const setup = databaseUrl
		? {
				url: databaseUrl,
				databaseType:
					selectedType ?? inferDatabaseType(databaseUrl, config.databaseType),
			}
		: await resolveInteractiveSetup(config, selectedType);

	const url = setup.url;
	const databaseType = setup.databaseType;

	if (!url) {
		printError(
			"No database URL provided.",
			"Run `qcp connect` for guided setup, or use:\n" +
				"  qcp connect postgres://user:pass@host:5432/dbname\n" +
				"Or set the QCP_DATABASE_URL environment variable.",
		);
		process.exit(1);
	}

	const spinner = ora(
		`Testing ${DATABASE_TYPE_INFO[databaseType].label} connection...`,
	).start();

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
		saveConfig({ ...config, databaseType, databaseUrl: url });

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
		printInfo(`Database type: ${DATABASE_TYPE_INFO[databaseType].label}`);
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

function parseDatabaseTypeOption(type: string | undefined): DatabaseType | undefined {
	if (!type) return undefined;

	if (isDatabaseType(type)) return type;

	printError(
		`Invalid database type: ${type}`,
		`Valid types: ${Object.keys(DATABASE_TYPE_INFO).join(", ")}`,
	);
	process.exit(1);
}

async function resolveInteractiveSetup(
	config: QcpConfig,
	selectedType: DatabaseType | undefined,
): Promise<{ url: string | undefined; databaseType: DatabaseType }> {
	if (!isatty(process.stdin.fd as number)) {
		const url = getDatabaseUrl(config);
		return {
			url,
			databaseType:
				selectedType ??
				(url ? inferDatabaseType(url, config.databaseType) : config.databaseType),
		};
	}

	const { databaseType } = await inquirer.prompt<{ databaseType: DatabaseType }>([
		{
			type: "select",
			name: "databaseType",
			message: "Select your database:",
			default: selectedType ?? config.databaseType,
			choices: (Object.keys(DATABASE_TYPE_INFO) as DatabaseType[]).map((type) => ({
				name: `${DATABASE_TYPE_INFO[type].label} — ${DATABASE_TYPE_INFO[type].description}`,
				value: type,
			})),
		},
	]);

	printConnectionGuidance(databaseType);

	const existingUrl = getDatabaseUrl(config);
	if (existingUrl) {
		const { useExisting } = await inquirer.prompt<{ useExisting: boolean }>([
			{
				type: "confirm",
				name: "useExisting",
				message: "Use the existing configured database URL?",
				default: true,
			},
		]);

		if (useExisting) {
			return {
				url: existingUrl,
				databaseType,
			};
		}
	}

	const { url } = await inquirer.prompt<{ url: string }>([
		{
			type: "password",
			name: "url",
			message: "Paste your PostgreSQL connection URL:",
			mask: "•",
			validate: validateDatabaseUrl,
		},
	]);

	return {
		url: url.trim(),
		databaseType,
	};
}

function printConnectionGuidance(databaseType: DatabaseType): void {
	const info = DATABASE_TYPE_INFO[databaseType];
	console.log();
	console.log(chalk.bold(`  ${info.label} connection`));
	for (const line of info.guidance) {
		console.log(chalk.dim(`  • ${line}`));
	}
	console.log();
}

function validateDatabaseUrl(input: string): true | string {
	const value = input.trim();
	if (!value) return "Database URL cannot be empty";
	if (!/^postgres(ql)?:\/\//i.test(value)) {
		return "Use a PostgreSQL URL that starts with postgres:// or postgresql://";
	}
	return true;
}

export async function showConnectionStatus(): Promise<void> {
	const config = loadConfig();
	const url = getDatabaseUrl(config);

	if (!url) {
		printInfo("No database connection configured.");
		printInfo("Run: qcp connect");
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
