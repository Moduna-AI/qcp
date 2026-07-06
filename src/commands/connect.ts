import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isatty } from "node:tty";
import chalk from "chalk";
import inquirer from "inquirer";
import ora from "ora";
import { defaultAmazonMarketingCloudApiBaseUrl } from "@/amc/config.js";
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
import { testConnection } from "@/db/index.js";
import {
	printError,
	printInfo,
	printSuccess,
	printWarning,
} from "@/output/index.js";
import type {
	AmazonMarketingCloudConnectionConfig,
	AmazonMarketingCloudRegion,
	DatabaseType,
	QcpConfig,
} from "@/types/index.js";

export interface ConnectOptions {
	name?: string;
	type?: string;
	schema?: string;
	datasource?: string;
	region?: string;
	apiBaseUrl?: string;
	instanceId?: string;
	clientId?: string;
	clientSecret?: string;
	refreshToken?: string;
	advertiserId?: string;
	marketplaceId?: string;
}

interface DatabaseTypeInfo {
	label: string;
	description: string;
	guidance: string[];
}

interface ResolvedConnectSetup {
	readonly name: string;
	readonly url: string | undefined;
	readonly databaseType: DatabaseType;
	readonly prismaSchemaPath?: string;
	readonly prismaDatasourceName?: string;
	readonly amazonMarketingCloud?: AmazonMarketingCloudConnectionConfig;
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
	"amazon-marketing-cloud": {
		label: "Amazon Marketing Cloud",
		description: "Amazon Ads AMC Reporting API",
		guidance: [
			"Use Amazon Ads API credentials with an LWA refresh token.",
			"AMC queries execute asynchronously as read-only workflow executions.",
			"Marketplace ID is required by the official AMC Reporting API.",
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
		? resolveNonInteractiveSetupWithArgument(
				config,
				requireNonInteractiveName(selectedName),
				databaseUrl,
				selectedType,
				options,
			)
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
	const amazonMarketingCloud =
		databaseType === "amazon-marketing-cloud"
			? setup.amazonMarketingCloud
			: undefined;

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
		amazonMarketingCloud,
	});

	if (!result.ok) {
		spinner.fail("Connection failed");
		printError(result.error);
		if (databaseType === "amazon-marketing-cloud") {
			printAmazonMarketingCloudConnectionFixes();
		} else {
			printCommonConnectionFixes();
		}
		process.exit(1);
	}
	if (result.operation === "remove") {
		spinner.fail("Connection failed");
		printError("Unexpected database removal result while connecting.");
		process.exit(1);
	}

	spinner.succeed(`Connected to ${result.databaseVersion}`);
	if (databaseType === "amazon-marketing-cloud") {
		printSuccess("AMC read-only workflow execution guardrails enabled");
	} else {
		printReadOnlyStatus(result.readOnly);
	}
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
	if (result.connection.amazonMarketingCloud) {
		printInfo(`AMC region: ${result.connection.amazonMarketingCloud.region}`);
		printInfo(
			`AMC marketplace: ${result.connection.amazonMarketingCloud.marketplaceId}`,
		);
	}
	printInfo("Run `qcp db list` to view configured databases");
}

function resolveNonInteractiveSetupWithArgument(
	config: QcpConfig,
	name: string,
	databaseUrl: string,
	selectedType: DatabaseType | undefined,
	options: ConnectOptions,
): ResolvedConnectSetup {
	const databaseType =
		selectedType ?? inferDatabaseType(databaseUrl, config.databaseType);
	if (databaseType === "amazon-marketing-cloud") {
		return {
			name,
			databaseType,
			...resolveNonInteractiveAmazonMarketingCloudSetup(databaseUrl, options),
		};
	}

	return {
		name,
		url: databaseUrl,
		databaseType,
		...resolveNonInteractivePrismaSetup(config, databaseType, options),
	};
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

function resolveNonInteractiveAmazonMarketingCloudSetup(
	apiBaseUrlArgument: string | undefined,
	options: ConnectOptions,
): {
	readonly url: string;
	readonly amazonMarketingCloud: AmazonMarketingCloudConnectionConfig;
} {
	const region = parseAmazonMarketingCloudRegion(
		options.region ?? process.env.QCP_AMC_REGION ?? "NA",
	);
	const apiBaseUrl =
		normalizeOptional(options.apiBaseUrl) ??
		normalizeOptional(apiBaseUrlArgument) ??
		process.env.QCP_AMC_API_BASE_URL ??
		defaultAmazonMarketingCloudApiBaseUrl(region);
	const amazonMarketingCloud: AmazonMarketingCloudConnectionConfig = {
		region,
		apiBaseUrl,
		instanceId: requireAmazonMarketingCloudValue(
			"instanceId",
			options.instanceId,
			process.env.QCP_AMC_INSTANCE_ID,
		),
		clientId: requireAmazonMarketingCloudValue(
			"clientId",
			options.clientId,
			process.env.QCP_AMC_CLIENT_ID,
		),
		clientSecret: requireAmazonMarketingCloudValue(
			"clientSecret",
			options.clientSecret,
			process.env.QCP_AMC_CLIENT_SECRET,
		),
		refreshToken: requireAmazonMarketingCloudValue(
			"refreshToken",
			options.refreshToken,
			process.env.QCP_AMC_REFRESH_TOKEN,
		),
		advertiserId: requireAmazonMarketingCloudValue(
			"advertiserId",
			options.advertiserId,
			process.env.QCP_AMC_ADVERTISER_ID,
		),
		marketplaceId: requireAmazonMarketingCloudValue(
			"marketplaceId",
			options.marketplaceId,
			process.env.QCP_AMC_MARKETPLACE_ID,
		),
	};
	return { url: apiBaseUrl, amazonMarketingCloud };
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
): Promise<ResolvedConnectSetup> {
	if (!isatty(process.stdin.fd as number)) {
		const url = getDatabaseUrl(config);
		const databaseType =
			selectedType ??
			(url ? inferDatabaseType(url, config.databaseType) : config.databaseType);
		if (databaseType === "amazon-marketing-cloud") {
			return {
				name: requireNonInteractiveName(selectedName),
				databaseType,
				...resolveNonInteractiveAmazonMarketingCloudSetup(url, options),
			};
		}
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
	if (databaseType === "amazon-marketing-cloud") {
		return {
			name,
			databaseType,
			...(await resolveInteractiveAmazonMarketingCloudSetup(
				existingConnection?.amazonMarketingCloud,
				options,
			)),
		};
	}

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

async function resolveInteractiveAmazonMarketingCloudSetup(
	existing: AmazonMarketingCloudConnectionConfig | undefined,
	options: ConnectOptions,
): Promise<{
	readonly url: string;
	readonly amazonMarketingCloud: AmazonMarketingCloudConnectionConfig;
}> {
	const parsedRegion = parseAmazonMarketingCloudRegion(
		options.region ?? existing?.region ?? process.env.QCP_AMC_REGION ?? "NA",
	);
	const answers = await inquirer.prompt<{
		region?: AmazonMarketingCloudRegion;
		apiBaseUrl?: string;
		instanceId?: string;
		clientId?: string;
		clientSecret?: string;
		refreshToken?: string;
		advertiserId?: string;
		marketplaceId?: string;
	}>([
		{
			type: "select",
			name: "region",
			message: "AMC region:",
			default: parsedRegion,
			choices: [
				{ name: "North America (NA)", value: "NA" },
				{ name: "Europe (EU)", value: "EU" },
				{ name: "Far East (FE)", value: "FE" },
			],
			when: !options.region,
		},
		{
			type: "input",
			name: "apiBaseUrl",
			message: "Amazon Ads API base URL:",
			default: (input: { region?: AmazonMarketingCloudRegion }) =>
				options.apiBaseUrl ??
				existing?.apiBaseUrl ??
				process.env.QCP_AMC_API_BASE_URL ??
				defaultAmazonMarketingCloudApiBaseUrl(input.region ?? parsedRegion),
			when: !options.apiBaseUrl,
			validate: validateUrl,
		},
		{
			type: "input",
			name: "instanceId",
			message: "AMC instance ID:",
			default: options.instanceId ?? existing?.instanceId,
			when: !options.instanceId,
			validate: validateNonEmpty("AMC instance ID"),
		},
		{
			type: "input",
			name: "clientId",
			message: "Amazon Ads API client ID:",
			default: options.clientId ?? existing?.clientId,
			when: !options.clientId,
			validate: validateNonEmpty("Client ID"),
		},
		{
			type: "password",
			name: "clientSecret",
			message: "Amazon Ads API client secret:",
			mask: "•",
			default: options.clientSecret ?? existing?.clientSecret,
			when: !options.clientSecret,
			validate: validateNonEmpty("Client secret"),
		},
		{
			type: "password",
			name: "refreshToken",
			message: "LWA refresh token:",
			mask: "•",
			default: options.refreshToken ?? existing?.refreshToken,
			when: !options.refreshToken,
			validate: validateNonEmpty("LWA refresh token"),
		},
		{
			type: "input",
			name: "advertiserId",
			message: "AMC account / advertiser ID:",
			default: options.advertiserId ?? existing?.advertiserId,
			when: !options.advertiserId,
			validate: validateNonEmpty("AMC account / advertiser ID"),
		},
		{
			type: "input",
			name: "marketplaceId",
			message: "Amazon marketplace ID:",
			default: options.marketplaceId ?? existing?.marketplaceId,
			when: !options.marketplaceId,
			validate: validateNonEmpty("Marketplace ID"),
		},
	]);

	const region = parseAmazonMarketingCloudRegion(
		options.region ?? answers.region ?? parsedRegion,
	);
	const apiBaseUrl =
		normalizeOptional(options.apiBaseUrl) ??
		normalizeOptional(answers.apiBaseUrl) ??
		existing?.apiBaseUrl ??
		defaultAmazonMarketingCloudApiBaseUrl(region);
	const amazonMarketingCloud: AmazonMarketingCloudConnectionConfig = {
		region,
		apiBaseUrl,
		instanceId:
			normalizeOptional(options.instanceId) ??
			normalizeOptional(answers.instanceId) ??
			existing?.instanceId ??
			"",
		clientId:
			normalizeOptional(options.clientId) ??
			normalizeOptional(answers.clientId) ??
			existing?.clientId ??
			"",
		clientSecret:
			normalizeOptional(options.clientSecret) ??
			normalizeOptional(answers.clientSecret) ??
			existing?.clientSecret ??
			"",
		refreshToken:
			normalizeOptional(options.refreshToken) ??
			normalizeOptional(answers.refreshToken) ??
			existing?.refreshToken ??
			"",
		advertiserId:
			normalizeOptional(options.advertiserId) ??
			normalizeOptional(answers.advertiserId) ??
			existing?.advertiserId ??
			"",
		marketplaceId:
			normalizeOptional(options.marketplaceId) ??
			normalizeOptional(answers.marketplaceId) ??
			existing?.marketplaceId ??
			"",
	};

	return { url: apiBaseUrl, amazonMarketingCloud };
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
	const value = input.trim();
	if (!value) return "Database URL cannot be empty";
	if (!/^postgres(ql)?:\/\//i.test(value)) {
		return "Use a PostgreSQL URL that starts with postgres:// or postgresql://";
	}
	return true;
}

function validateUrl(input: string): true | string {
	try {
		new URL(input.trim());
		return true;
	} catch {
		return "Use a valid URL.";
	}
}

function validateNonEmpty(label: string): (input: string) => true | string {
	return (input: string) =>
		input.trim().length > 0 ? true : `${label} cannot be empty`;
}

function requireAmazonMarketingCloudValue(
	label: string,
	optionValue: string | undefined,
	envValue: string | undefined,
): string {
	const value = normalizeOptional(optionValue) ?? normalizeOptional(envValue);
	if (value) return value;

	printError(
		`Missing Amazon Marketing Cloud ${label}.`,
		`Pass --${kebabCase(label)} or set ${amazonMarketingCloudEnvName(label)}.`,
	);
	process.exit(1);
}

function parseAmazonMarketingCloudRegion(
	region: string,
): AmazonMarketingCloudRegion {
	const normalized = region.trim().toUpperCase();
	if (normalized === "NA" || normalized === "EU" || normalized === "FE") {
		return normalized;
	}
	printError("Invalid AMC region.", "Valid regions: NA, EU, FE");
	process.exit(1);
}

function kebabCase(value: string): string {
	return value.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function amazonMarketingCloudEnvName(label: string): string {
	return `QCP_AMC_${label.replace(/[A-Z]/g, (char) => `_${char}`).toUpperCase()}`;
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

export function printAmazonMarketingCloudConnectionFixes(): void {
	console.log();
	printInfo("Common AMC fixes:");
	console.log(chalk.dim("  • Verify the LWA refresh token is valid"));
	console.log(chalk.dim("  • Check the Amazon Ads API client ID and secret"));
	console.log(
		chalk.dim("  • Confirm the AMC instance, advertiser, and marketplace IDs"),
	);
	console.log(
		chalk.dim("  • Ensure the selected region matches the AMC account"),
	);
}

export async function showConnectionStatus(): Promise<void> {
	const config = loadConfig();
	const connection = getActiveDatabaseConnection(config);

	if (!connection) {
		printInfo("No database connection configured.");
		printInfo("Run: qcp connect");
		return;
	}

	if (connection.databaseType === "amazon-marketing-cloud") {
		if (connection.amazonMarketingCloud) {
			printSuccess("Amazon Marketing Cloud profile configured");
			printInfo(`Connection: ${connection.name}`);
			printInfo(`Region: ${connection.amazonMarketingCloud.region}`);
			printInfo(
				`Marketplace: ${connection.amazonMarketingCloud.marketplaceId}`,
			);
			return;
		}

		printWarning("Amazon Marketing Cloud profile is missing credentials.");
		printInfo("Run: qcp connect --type amazon-marketing-cloud");
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
