import { isatty } from "node:tty";
import chalk from "chalk";
import inquirer from "inquirer";
import { DatabaseConnectionManager } from "@/config/database-connection-manager.js";
import {
	DatabaseConnectionRegistry,
	normalizeDatabaseAlias,
} from "@/config/database-connection-registry.js";
import {
	getActiveDatabaseConnection,
	isDatabaseType,
	loadConfig,
	saveConfig,
} from "@/config/index.js";
import {
	buildAuditResource,
	resolveAuditActor,
	writeAuditEvent,
} from "@/logger/audit.js";
import {
	printError,
	printInfo,
	printSection,
	printSuccess,
} from "@/output/index.js";
import { schemaCatalogHasConnection } from "@/schema/index.js";
import type { DatabaseConnectionConfig, DatabaseType } from "@/types/index.js";
import {
	DATABASE_TYPE_INFO,
	normalizeOptional,
	printCommonConnectionFixes,
	printConnectionGuidance,
	printReadOnlyStatus,
	printSchemaStatus,
	validateConnectionName,
	validateDatabaseUrl,
	validatePrismaDatasourceName,
	validatePrismaSchemaPath,
} from "./connect.js";

export interface DbRemoveOptions {
	yes?: boolean;
}

export interface DbEditOptions {
	name?: string;
	type?: string;
	schema?: string;
	datasource?: string;
}

export function dbListCommand(): void {
	const config = loadConfig();
	const registry = new DatabaseConnectionRegistry(config);
	const active = registry.getActive();
	const connections = registry.list();

	if (connections.length === 0) {
		printInfo("No database connections configured.");
		printInfo("Run: qcp connect --name default");
		return;
	}

	printSection("Database Connections");
	for (const connection of connections) {
		const marker = connection.id === active?.id ? chalk.green("*") : " ";
		const schemaStatus = schemaCatalogHasConnection(connection.id)
			? chalk.green("schema indexed")
			: chalk.yellow("schema missing");
		console.log(
			`  ${marker} ${chalk.cyan(connection.name.padEnd(18))} ${chalk.dim(connection.databaseType.padEnd(16))} ${schemaStatus}`,
		);
	}
}

export function dbCurrentCommand(): void {
	const config = loadConfig();
	const connection = getActiveDatabaseConnection(config);

	if (!connection) {
		printInfo("No active database connection configured.");
		printInfo("Run: qcp connect --name default");
		return;
	}

	printSection("Active Database");
	console.log(`  Alias:      ${chalk.bold(connection.name)}`);
	console.log(`  Type:       ${chalk.dim(connection.databaseType)}`);
	console.log(
		`  Schema:     ${
			schemaCatalogHasConnection(connection.id)
				? chalk.green("indexed")
				: chalk.yellow("missing")
		}`,
	);
}

export async function dbUseCommand(name: string): Promise<void> {
	const config = loadConfig();
	const registry = new DatabaseConnectionRegistry(config);

	try {
		const alias = normalizeDatabaseAlias(name);
		const snapshot = registry.use(alias);
		saveConfig({
			...config,
			databaseConnections: snapshot.connections,
			activeDatabaseId: snapshot.activeDatabaseId,
		});
		const connection = registry.findByName(alias);
		await auditDbEvent(config, "db use", "CONNECTION_CHANGE", "success", {
			connectionId: connection?.id,
			connectionName: alias,
			databaseType: connection?.databaseType,
		});
		printSuccess(`Active database = ${alias}`);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		await auditDbEvent(config, "db use", "CONNECTION_CHANGE", "failure", {
			connectionName: name,
			error: message,
		});
		printError(message);
		process.exit(1);
	}
}

export async function dbRemoveCommand(
	name: string,
	options: DbRemoveOptions = {},
): Promise<void> {
	const config = loadConfig();
	const registry = new DatabaseConnectionRegistry(config);
	const alias = normalizeDatabaseAlias(name);
	const connection = registry.findByName(alias);

	if (!connection) {
		printError(`Database connection not found: ${alias}`);
		process.exit(1);
	}

	if (!options.yes) {
		const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
			{
				type: "confirm",
				name: "confirmed",
				message: `Remove database connection "${alias}" and its schema cache?`,
				default: false,
			},
		]);

		if (!confirmed) {
			printInfo("Database connection was not removed.");
			return;
		}
	}

	const manager = new DatabaseConnectionManager();
	const result = await manager.remove({ alias });
	if (!result.ok) {
		printError(result.error);
		process.exit(1);
	}
	if (result.operation !== "remove") {
		printError("Unexpected database update result while removing.");
		process.exit(1);
	}

	printSuccess(`Removed database connection: ${alias}`);
	if (result.activeDatabaseId) {
		const active = getActiveDatabaseConnection(result.config);
		if (active) printInfo(`Active database = ${active.name}`);
	} else {
		printInfo("No active database connection configured.");
	}
}

export async function dbEditCommand(
	alias: string,
	databaseUrl?: string,
	options: DbEditOptions = {},
): Promise<void> {
	const config = loadConfig();
	const registry = new DatabaseConnectionRegistry(config);
	const normalizedAlias = normalizeDatabaseAlias(alias);
	const existingConnection = registry.findByName(normalizedAlias);

	if (!existingConnection) {
		printError(`Database connection not found: ${normalizedAlias}`);
		process.exit(1);
	}

	const setup = await resolveEditSetup(
		existingConnection,
		databaseUrl,
		options,
	);
	if (!setup) {
		printError(
			"No database connection changes provided.",
			"Use: qcp db edit prod --name production --type neon postgres://readonly_user:password@host/db",
		);
		process.exit(1);
	}

	const manager = new DatabaseConnectionManager();
	const result = await manager.edit({
		alias: normalizedAlias,
		name: setup.name,
		databaseType: setup.databaseType,
		databaseUrl: setup.databaseUrl,
		prismaSchemaPath: setup.prismaSchemaPath,
		prismaDatasourceName: setup.prismaDatasourceName,
	});

	if (!result.ok) {
		printError(result.error);
		printCommonConnectionFixes();
		process.exit(1);
	}
	if (result.operation === "remove") {
		printError("Unexpected database removal result while editing.");
		process.exit(1);
	}

	printSuccess(`Database connection updated: ${result.connection.name}`);
	printInfo(`Connected to ${result.databaseVersion}`);
	printInfo(
		`Database type: ${DATABASE_TYPE_INFO[result.connection.databaseType].label}`,
	);
	if (result.connection.prismaSchemaPath) {
		printInfo(`Prisma schema: ${result.connection.prismaSchemaPath}`);
	}
	if (result.connection.prismaDatasourceName) {
		printInfo(`Prisma datasource: ${result.connection.prismaDatasourceName}`);
	}
	printReadOnlyStatus(result.readOnly);
	printSchemaStatus(result.connection.name, result.schema);
}

async function resolveEditSetup(
	existingConnection: DatabaseConnectionConfig,
	databaseUrl: string | undefined,
	options: DbEditOptions,
): Promise<ResolvedEditSetup | undefined> {
	const selectedType = parseDatabaseType(options.type);
	const selectedName = parseOptionalConnectionName(options.name);
	const providedSchemaPath = normalizeOptional(options.schema);
	const providedDatasourceName = normalizeOptional(options.datasource);
	const providedUrl = normalizeOptional(databaseUrl);
	if (providedUrl) validateProvidedInput(providedUrl, validateDatabaseUrl);

	if (!isatty(process.stdin.fd as number)) {
		if (
			!selectedName &&
			!selectedType &&
			!providedUrl &&
			!providedSchemaPath &&
			!providedDatasourceName
		) {
			return undefined;
		}

		const databaseType = selectedType ?? existingConnection.databaseType;
		if (databaseType === "prisma-postgres") {
			if (providedSchemaPath) {
				validateProvidedInput(providedSchemaPath, validatePrismaSchemaPath);
			}
			if (providedDatasourceName) {
				validateProvidedInput(
					providedDatasourceName,
					validatePrismaDatasourceName,
				);
			}
		}
		return {
			name: selectedName,
			databaseType: selectedType,
			databaseUrl: providedUrl,
			prismaSchemaPath:
				databaseType === "prisma-postgres" ? providedSchemaPath : undefined,
			prismaDatasourceName:
				databaseType === "prisma-postgres" ? providedDatasourceName : undefined,
		};
	}

	const { name } = selectedName
		? { name: selectedName }
		: await inquirer.prompt<{ name: string }>([
				{
					type: "input",
					name: "name",
					message: "Connection alias:",
					default: existingConnection.name,
					filter: (value: string) => value.trim().toLowerCase(),
					validate: validateConnectionName,
				},
			]);

	const { databaseType } = selectedType
		? { databaseType: selectedType }
		: await inquirer.prompt<{ databaseType: DatabaseType }>([
				{
					type: "select",
					name: "databaseType",
					message: "Select your database:",
					default: existingConnection.databaseType,
					choices: (Object.keys(DATABASE_TYPE_INFO) as DatabaseType[]).map(
						(type) => ({
							name: `${DATABASE_TYPE_INFO[type].label} — ${DATABASE_TYPE_INFO[type].description}`,
							value: type,
						}),
					),
				},
			]);

	printConnectionGuidance(databaseType);
	const finalUrl =
		providedUrl ??
		(await resolveInteractiveEditDatabaseUrl(existingConnection));
	const prismaSetup = await resolveEditPrismaSetup(
		existingConnection,
		databaseType,
		providedSchemaPath,
		providedDatasourceName,
	);

	return {
		name,
		databaseType,
		databaseUrl: finalUrl,
		...prismaSetup,
	};
}

async function resolveInteractiveEditDatabaseUrl(
	existingConnection: DatabaseConnectionConfig,
): Promise<string | undefined> {
	const { updateUrl } = await inquirer.prompt<{ updateUrl: boolean }>([
		{
			type: "confirm",
			name: "updateUrl",
			message: `Update database URL for "${existingConnection.name}"?`,
			default: false,
		},
	]);

	if (!updateUrl) return undefined;

	const { url } = await inquirer.prompt<{ url: string }>([
		{
			type: "password",
			name: "url",
			message: "Paste your PostgreSQL connection URL:",
			mask: "•",
			validate: validateDatabaseUrl,
		},
	]);

	return url.trim();
}

async function resolveEditPrismaSetup(
	existingConnection: DatabaseConnectionConfig,
	databaseType: DatabaseType,
	providedSchemaPath: string | undefined,
	providedDatasourceName: string | undefined,
): Promise<{
	readonly prismaSchemaPath?: string;
	readonly prismaDatasourceName?: string;
}> {
	if (databaseType !== "prisma-postgres") return {};
	if (providedSchemaPath) {
		validateProvidedInput(providedSchemaPath, validatePrismaSchemaPath);
	}
	if (providedDatasourceName) {
		validateProvidedInput(providedDatasourceName, validatePrismaDatasourceName);
	}

	const defaultSchemaPath =
		providedSchemaPath ??
		existingConnection.prismaSchemaPath ??
		"prisma/schema.prisma";
	const defaultDatasourceName =
		providedDatasourceName ?? existingConnection.prismaDatasourceName ?? "db";
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

function parseDatabaseType(type: string | undefined): DatabaseType | undefined {
	if (!type) return undefined;
	if (isDatabaseType(type)) return type;

	printError(
		`Invalid database type: ${type}`,
		`Valid types: ${Object.keys(DATABASE_TYPE_INFO).join(", ")}`,
	);
	process.exit(1);
}

function parseOptionalConnectionName(
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

function validateProvidedInput(
	value: string,
	validate: (input: string) => true | string,
): void {
	const result = validate(value);
	if (result === true) return;

	printError(result);
	process.exit(1);
}

async function auditDbEvent(
	config: ReturnType<typeof loadConfig>,
	command: string,
	action: "CONNECTION_CHANGE",
	outcome: "success" | "failure",
	resource: {
		readonly connectionId?: string;
		readonly connectionName?: string;
		readonly databaseType?: ReturnType<typeof loadConfig>["databaseType"];
		readonly error?: string;
	},
): Promise<void> {
	await writeAuditEvent({
		scope: "system_admin",
		action,
		actor: resolveAuditActor(config.installId),
		resource: buildAuditResource({
			command,
			installId: config.installId,
			connectionId: resource.connectionId,
			connectionName: resource.connectionName,
			databaseType: resource.databaseType,
			provider: config.provider,
			model: config.model,
		}),
		delta: null,
		outcome,
		metadata: {
			error: resource.error ?? null,
		},
	});
}

interface ResolvedEditSetup {
	readonly name?: string;
	readonly databaseType?: DatabaseType;
	readonly databaseUrl?: string;
	readonly prismaSchemaPath?: string;
	readonly prismaDatasourceName?: string;
}
