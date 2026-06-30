import chalk from "chalk";
import inquirer from "inquirer";
import {
	DatabaseConnectionRegistry,
	normalizeDatabaseAlias,
} from "@/config/database-connection-registry.js";
import {
	getActiveDatabaseConnection,
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
import {
	removeSchemaForConnection,
	schemaCatalogHasConnection,
} from "@/schema/index.js";

export interface DbRemoveOptions {
	yes?: boolean;
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

	const snapshot = registry.remove(alias);
	saveConfig({
		...config,
		databaseConnections: snapshot.connections,
		activeDatabaseId: snapshot.activeDatabaseId,
	});
	removeSchemaForConnection(connection.id);
	await auditDbEvent(config, "db remove", "CONNECTION_CHANGE", "success", {
		connectionId: connection.id,
		connectionName: alias,
		databaseType: connection.databaseType,
	});
	printSuccess(`Removed database connection: ${alias}`);
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
