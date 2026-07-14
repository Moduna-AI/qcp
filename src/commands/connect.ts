import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isatty } from "node:tty";
import chalk from "chalk";
import inquirer from "inquirer";
import ora from "ora";
import { DatabaseConnectionManager } from "@/config/database-connection-manager.js";
import {
	DatabaseConnectionRegistry,
	normalizeDatabaseAlias,
} from "@/config/database-connection-registry.js";
import {
	getActiveDatabaseConnection,
	getDatabaseUrl,
	inferDatabaseType,
	isDatabaseType,
	loadConfig,
	withActiveDatabaseConnection,
} from "@/config/index.js";
import { PostgresConnectionValidator } from "@/config/postgres-connection-validator.js";
import { testConnection } from "@/db/index.js";
import {
	printError,
	printInfo,
	printSuccess,
	printWarning,
} from "@/output/index.js";
import type { DatabaseType, QcpConfig } from "@/types/index.js";

export interface ConnectOptions {
	name?: string;
	type?: string;
	schema?: string;
	datasource?: string;
}

interface DatabaseTypeInfo {
	label: string;
	description: string;
	guidance: string[];
}

export const DATABASE_TYPE_INFO: Record<DatabaseType, DatabaseTypeInfo> = {
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
	const selectedName = parseConnectionNameOption(options.name);
	const setup = databaseUrl
		? {
				name: requireNonInteractiveName(selectedName),
				url: databaseUrl,
				databaseType:
					selectedType ?? inferDatabaseType(databaseUrl, config.databaseType),
				...resolveNonInteractivePrismaSetup(
					config,
					selectedType ?? inferDatabaseType(databaseUrl, config.databaseType),
					options,
				),
			}
		: await resolveInteractiveSetup(
				config,
				selectedName,
				selectedType,
				options,
			);

	const name = setup.name;
	const url = setup.url;
	const databaseType = setup.databaseType;
	const prismaSchemaPath =
		databaseType === "prisma-postgres" ? setup.prismaSchemaPath : undefined;
	const prismaDatasourceName =
		databaseType === "prisma-postgres" ? setup.prismaDatasourceName : undefined;

	if (!url) {
		printError(
			"No database URL provided.",
			"Run `qcp connect` for guided setup, or use:\n" +
				"  qcp connect --name prod postgres://user:pass@host:5432/dbname\n" +
				"Or set the QCP_DATABASE_URL environment variable.",
		);
		process.exit(1);
	}

	const spinner = ora(
		`Testing ${DATABASE_TYPE_INFO[databaseType].label} connection...`,
	).start();
	const manager = new DatabaseConnectionManager();
	const result = await manager.add({
		name,
		databaseType,
		databaseUrl: url,
		prismaSchemaPath,
		prismaDatasourceName,
	});

	if (!result.ok) {
		spinner.fail("Connection failed");
		printError(result.error);
		printCommonConnectionFixes();
		process.exit(1);
	}
	if (result.operation === "remove") {
		spinner.fail("Connection failed");
		printError("Unexpected database removal result while connecting.");
		process.exit(1);
	}

	spinner.succeed(`Connected to ${result.databaseVersion}`);
	printConnectionWarnings(result.connectionWarnings);
	printReadOnlyStatus(result.readOnly);
	printSchemaStatus(result.connection.name, result.schema);
	printSuccess("Database connection saved");
	printInfo(`Connection: ${result.connection.name} (active)`);
	printInfo(
		`Database type: ${DATABASE_TYPE_INFO[result.connection.databaseType].label}`,
	);
	if (result.connection.prismaSchemaPath) {
		printInfo(`Prisma schema: ${result.connection.prismaSchemaPath}`);
	}
	if (result.connection.prismaDatasourceName) {
		printInfo(`Prisma datasource: ${result.connection.prismaDatasourceName}`);
	}
	printInfo("Run `qcp db list` to view configured databases");
}

function resolveNonInteractivePrismaSetup(
	config: QcpConfig,
	databaseType: DatabaseType,
	options: ConnectOptions,
): {
	prismaSchemaPath?: string;
	prismaDatasourceName?: string;
} {
	if (databaseType !== "prisma-postgres") return {};

	return {
		prismaSchemaPath:
			normalizeOptional(options.schema) ?? config.prismaSchemaPath,
		prismaDatasourceName:
			normalizeOptional(options.datasource) ?? config.prismaDatasourceName,
	};
}

export function parseDatabaseTypeOption(
	type: string | undefined,
): DatabaseType | undefined {
	if (!type) return undefined;

	if (isDatabaseType(type)) return type;

	printError(
		`Invalid database type: ${type}`,
		`Valid types: ${Object.keys(DATABASE_TYPE_INFO).join(", ")}`,
	);
	process.exit(1);
}

export function parseConnectionNameOption(
	name: string | undefined,
): string | undefined {
	if (!name) return undefined;

	try {
		return normalizeDatabaseAlias(name);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		printError(message);
		process.exit(1);
	}
}

function requireNonInteractiveName(name: string | undefined): string {
	if (name) return name;

	printError(
		"Connection name is required.",
		"Use: qcp connect --name prod postgres://readonly_user:password@host/db",
	);
	process.exit(1);
}

async function resolveInteractiveSetup(
	config: QcpConfig,
	selectedName: string | undefined,
	selectedType: DatabaseType | undefined,
	options: ConnectOptions,
): Promise<{
	name: string;
	url: string | undefined;
	databaseType: DatabaseType;
	prismaSchemaPath?: string;
	prismaDatasourceName?: string;
}> {
	if (!isatty(process.stdin.fd as number)) {
		const url = getDatabaseUrl(config);
		const databaseType =
			selectedType ??
			(url ? inferDatabaseType(url, config.databaseType) : config.databaseType);
		return {
			name: requireNonInteractiveName(selectedName),
			url,
			databaseType,
			prismaSchemaPath:
				databaseType === "prisma-postgres"
					? (normalizeOptional(options.schema) ?? config.prismaSchemaPath)
					: undefined,
			prismaDatasourceName:
				databaseType === "prisma-postgres"
					? (normalizeOptional(options.datasource) ??
						config.prismaDatasourceName)
					: undefined,
		};
	}

	const { databaseType } = selectedType
		? { databaseType: selectedType }
		: await inquirer.prompt<{
				databaseType: DatabaseType;
			}>([
				{
					type: "select",
					name: "databaseType",
					message: "Select your database:",
					default: config.databaseType,
					choices: (Object.keys(DATABASE_TYPE_INFO) as DatabaseType[]).map(
						(type) => ({
							name: `${DATABASE_TYPE_INFO[type].label} — ${DATABASE_TYPE_INFO[type].description}`,
							value: type,
						}),
					),
				},
			]);

	printConnectionGuidance(databaseType);

	const { name } = selectedName
		? { name: selectedName }
		: await inquirer.prompt<{ name: string }>([
				{
					type: "input",
					name: "name",
					message: "Connection alias:",
					default: "default",
					filter: (value: string) => value.trim().toLowerCase(),
					validate: validateConnectionName,
				},
			]);

	const existingConnection = new DatabaseConnectionRegistry(config).findByName(
		name,
	);
	const existingUrl = existingConnection
		? getActiveDatabaseConnection(
				withActiveDatabaseConnection(config, {
					id: existingConnection.id,
					name: existingConnection.name,
					databaseType: existingConnection.databaseType,
					databaseUrl: existingConnection.databaseUrl,
					prismaSchemaPath: existingConnection.prismaSchemaPath,
					prismaDatasourceName: existingConnection.prismaDatasourceName,
				}),
				name,
			)?.databaseUrl
		: undefined;
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
				name,
				url: existingUrl,
				databaseType,
				...(await resolvePrismaSetup(config, databaseType, options)),
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
		name,
		url: url.trim(),
		databaseType,
		...(await resolvePrismaSetup(config, databaseType, options)),
	};
}

async function resolvePrismaSetup(
	config: QcpConfig,
	databaseType: DatabaseType,
	options: ConnectOptions,
): Promise<{
	prismaSchemaPath?: string;
	prismaDatasourceName?: string;
}> {
	if (databaseType !== "prisma-postgres") return {};

	const providedSchemaPath = normalizeOptional(options.schema);
	const providedDatasourceName = normalizeOptional(options.datasource);
	if (providedSchemaPath && providedDatasourceName) {
		return {
			prismaSchemaPath: providedSchemaPath,
			prismaDatasourceName: providedDatasourceName,
		};
	}

	const defaultSchemaPath =
		providedSchemaPath ?? config.prismaSchemaPath ?? "prisma/schema.prisma";
	const defaultDatasourceName =
		providedDatasourceName ?? config.prismaDatasourceName ?? "db";

	const answers = await inquirer.prompt<{
		prismaSchemaPath: string;
		prismaDatasourceName: string;
	}>([
		{
			type: "input",
			name: "prismaSchemaPath",
			message: "Local schema.prisma path:",
			default: defaultSchemaPath,
			validate: validatePrismaSchemaPath,
			when: !providedSchemaPath,
		},
		{
			type: "input",
			name: "prismaDatasourceName",
			message: "Prisma datasource name:",
			default: defaultDatasourceName,
			validate: validatePrismaDatasourceName,
			when: !providedDatasourceName,
		},
	]);

	return {
		prismaSchemaPath: providedSchemaPath ?? answers.prismaSchemaPath.trim(),
		prismaDatasourceName:
			providedDatasourceName ?? answers.prismaDatasourceName.trim(),
	};
}

export function printConnectionGuidance(databaseType: DatabaseType): void {
	const info = DATABASE_TYPE_INFO[databaseType];
	console.log();
	console.log(chalk.bold(`  ${info.label} connection`));
	for (const line of info.guidance) {
		console.log(chalk.dim(`  • ${line}`));
	}
	console.log();
}

export function validateDatabaseUrl(input: string): true | string {
	try {
		new PostgresConnectionValidator().validate(input);
		return true;
	} catch (err: unknown) {
		return err instanceof Error
			? err.message
			: "Invalid PostgreSQL connection URI.";
	}
}

export function validateConnectionName(input: string): true | string {
	try {
		normalizeDatabaseAlias(input);
		return true;
	} catch (err: unknown) {
		return err instanceof Error ? err.message : String(err);
	}
}

export function validatePrismaSchemaPath(input: string): true | string {
	const value = input.trim();
	if (!value) return "Prisma schema path cannot be empty";
	if (!value.endsWith(".prisma")) return "Use a .prisma schema file";
	if (!existsSync(resolve(value))) {
		return "File does not exist from the current working directory";
	}
	return true;
}

export function validatePrismaDatasourceName(input: string): true | string {
	const value = input.trim();
	if (!value) return "Datasource name cannot be empty";
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
		return "Use a valid Prisma identifier, such as db";
	}
	return true;
}

export function normalizeOptional(
	value: string | undefined,
): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

export function printReadOnlyStatus(readOnly: boolean): void {
	if (readOnly) {
		printSuccess("Read-only user verified");
		return;
	}

	printWarning(
		"Best-effort privilege inspection found write permissions. qcp enforces read-only at the " +
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

export function printConnectionWarnings(
	warnings: readonly "tls-not-required"[],
): void {
	if (warnings.includes("tls-not-required")) {
		printWarning(
			"TLS is not explicitly required for this remote database. Add sslmode=require (or verify-full) to the connection URI.",
		);
	}
}

export function printSchemaStatus(
	connectionName: string,
	schema: {
		readonly status: "updated" | "failed";
		readonly databaseName?: string;
		readonly tableCount?: number;
		readonly error?: string;
	},
): void {
	if (schema.status === "updated") {
		printSuccess(
			`Schema indexed (${schema.tableCount} tables from ${schema.databaseName})`,
		);
		return;
	}

	printWarning(
		`Connection was saved, but schema scan failed: ${schema.error}\nRun: qcp schema scan --database ${connectionName}`,
	);
}

export function printCommonConnectionFixes(): void {
	console.log();
	printInfo("Common fixes:");
	console.log(chalk.dim("  • Check the database host and port are reachable"));
	console.log(chalk.dim("  • Verify the username and password are correct"));
	console.log(chalk.dim("  • Ensure the database name exists"));
	console.log(chalk.dim("  • Check firewall rules and pg_hba.conf"));
}

export async function showConnectionStatus(): Promise<void> {
	const config = loadConfig();
	const connection = getActiveDatabaseConnection(config);

	if (!connection) {
		printInfo("No database connection configured.");
		printInfo("Run: qcp connect");
		return;
	}

	const spinner = ora(`Checking connection ${connection.name}...`).start();
	const result = await testConnection(connection.databaseUrl);

	if (result.connected) {
		spinner.succeed(`Connected: ${result.version}`);
	} else {
		spinner.fail(`Connection lost: ${result.error}`);
	}
}
