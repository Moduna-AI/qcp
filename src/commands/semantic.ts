import chalk from "chalk";
import ora from "ora";
import {
	getActiveDatabaseConnection,
	LOCAL_SEMANTIC_DB_PATH,
	loadConfig,
	withActiveDatabaseConnection,
} from "@/config/index.js";
import type { AuditContext } from "@/logger/audit.js";
import {
	printError,
	printInfo,
	printSection,
	printSuccess,
	printWarning,
} from "@/output/index.js";
import { ensurePackageGroups } from "@/packages/runtime.js";
import { loadSchemaForConnection } from "@/schema/index.js";
import { writeSemanticAuditEvent } from "@/semantic/audit.js";
import { SemanticSchemaIndexer } from "@/semantic/indexer.js";
import { startSemanticMcpServer } from "@/semantic/mcp-server.js";
import { SemanticValueProfiler } from "@/semantic/profile.js";
import {
	CliSemanticQuestionAdapter,
	HumanSemanticQuestionService,
	McpSemanticQuestionAdapter,
} from "@/semantic/question-service.js";
import { SemanticStore, semanticStoreExists } from "@/semantic/store.js";
import { createSemanticTools } from "@/semantic/tools.js";
import type { SemanticObject, SemanticSyncReport } from "@/semantic/types.js";
import type {
	ActiveDatabaseConnection,
	DatabaseSchema,
	QcpConfig,
	SchemaTable,
} from "@/types/index.js";

export interface SemanticDatabaseOptions {
	readonly database?: string;
}

export interface SemanticScanOptions extends SemanticDatabaseOptions {
	readonly verbose?: boolean;
}

export interface SemanticStatusOptions extends SemanticDatabaseOptions {}

export interface SemanticEnrichOptions extends SemanticDatabaseOptions {
	readonly table?: string;
	readonly column?: string;
	readonly force?: boolean;
}

export interface SemanticProfileOptions extends SemanticDatabaseOptions {
	readonly columns?: readonly string[];
	readonly includeSensitive?: boolean;
	readonly limit?: number;
}

export interface SemanticMcpOptions extends SemanticDatabaseOptions {}

interface SemanticEnvironment {
	readonly config: QcpConfig;
	readonly activeConfig: QcpConfig;
	readonly connection: ActiveDatabaseConnection;
	readonly schema: DatabaseSchema;
}

export class SemanticCommandError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "SemanticCommandError";
	}
}

export async function semanticScanCommand(
	options: SemanticScanOptions = {},
): Promise<void> {
	await ensureSemanticPackages("qcp semantic scan", ["semantic"]);
	const store = new SemanticStore();

	try {
		const environment = loadSemanticEnvironment(options);
		const spinner = ora(
			`Syncing semantic objects for ${environment.connection.name}...`,
		).start();
		const report = await syncSemanticSchema(store, environment);
		spinner.succeed(
			`Synced ${report.syncedObjects} semantic objects and ${report.syncedRelationships} relationships`,
		);

		await writeSemanticAuditEvent({
			context: auditContextForSemanticCommand(environment, "semantic scan"),
			action: "SEMANTIC_SCAN",
			outcome: "success",
			metadata: {
				syncedObjects: report.syncedObjects,
				syncedRelationships: report.syncedRelationships,
				staleObjects: report.staleObjects,
				inactiveObjects: report.inactiveObjects,
				changedObjects: report.changedObjects,
				semanticDbPath: LOCAL_SEMANTIC_DB_PATH,
			},
		});

		printSuccess(`Semantic store saved to ${LOCAL_SEMANTIC_DB_PATH}`);
		printInfo(`Connection: ${environment.connection.name}`);
		printInfo(`Changed objects: ${report.changedObjects}`);
		printInfo(`Stale objects needing review: ${report.staleObjects}`);
	} catch (err: unknown) {
		printSemanticCommandError(err);
		process.exit(1);
	} finally {
		await store.close();
	}
}

export async function semanticStatusCommand(
	options: SemanticStatusOptions = {},
): Promise<void> {
	if (!semanticStoreExists()) {
		printInfo("No semantic store found.");
		printInfo("Run: qcp semantic scan");
		return;
	}

	await ensureSemanticPackages("qcp semantic status", ["semantic"]);
	const store = new SemanticStore();

	try {
		const environment = loadSemanticEnvironment(options);
		const hasState = await store.hasConnectionState(environment.connection.id);
		if (!hasState) {
			printInfo(
				`No semantic objects found for ${environment.connection.name}.`,
			);
			printInfo("Run: qcp semantic scan");
			return;
		}

		const coverage = await store.getCoverageReport(environment.connection.id);
		printSection("Semantic Coverage");
		console.log(`  Connection: ${chalk.bold(environment.connection.name)}`);
		console.log(`  Store:      ${chalk.dim(LOCAL_SEMANTIC_DB_PATH)}`);
		console.log(
			`  Objects:    ${chalk.bold(String(coverage.enrichedObjects))}/${coverage.totalObjects} enriched (${formatPercent(coverage.enrichedObjects, coverage.totalObjects)})`,
		);
		console.log(`  Stale:      ${chalk.bold(String(coverage.staleObjects))}`);
		console.log();
		console.log(
			`  ${chalk.cyan("tables".padEnd(10))} ${coverage.byType.table.enriched}/${coverage.byType.table.total} enriched · ${coverage.byType.table.stale} stale`,
		);
		console.log(
			`  ${chalk.cyan("columns".padEnd(10))} ${coverage.byType.column.enriched}/${coverage.byType.column.total} enriched · ${coverage.byType.column.stale} stale`,
		);
	} catch (err: unknown) {
		printSemanticCommandError(err);
		process.exit(1);
	} finally {
		await store.close();
	}
}

export async function semanticEnrichCommand(
	options: SemanticEnrichOptions = {},
): Promise<void> {
	await ensureSemanticPackages("qcp semantic enrich", ["semantic"]);
	const store = new SemanticStore();

	try {
		const environment = loadSemanticEnvironment(options);
		await syncSemanticSchema(store, environment);
		const objects = await filterEnrichmentObjects({
			store,
			connectionId: environment.connection.id,
			schema: environment.schema,
			tableSelector: options.table,
			columnSelector: options.column,
			force: options.force ?? false,
		});

		if (objects.length === 0) {
			printSuccess("No semantic objects need enrichment.");
			return;
		}

		printSection("Semantic Enrichment");
		printInfo(`Connection: ${environment.connection.name}`);
		printInfo(`Objects queued: ${objects.length}`);
		const service = new HumanSemanticQuestionService({
			store,
			cliAdapter: new CliSemanticQuestionAdapter(),
		});
		const result = await service.enrichObjects(objects);

		await writeSemanticAuditEvent({
			context: auditContextForSemanticCommand(environment, "semantic enrich"),
			action: "SEMANTIC_ANNOTATION",
			outcome: result.accepted > 0 ? "success" : "cancelled",
			metadata: {
				queuedObjects: objects.length,
				accepted: result.accepted,
				declined: result.declined,
				cancelled: result.cancelled,
				skipped: result.skipped,
			},
		});

		printSuccess(`Saved ${result.accepted} semantic annotation(s).`);
		if (result.declined > 0) printInfo(`Declined: ${result.declined}`);
		if (result.cancelled > 0) printInfo(`Cancelled: ${result.cancelled}`);
		if (result.skipped > 0) printInfo(`Skipped: ${result.skipped}`);
	} catch (err: unknown) {
		printSemanticCommandError(err);
		process.exit(1);
	} finally {
		await store.close();
	}
}

export async function semanticProfileCommand(
	tableSelector: string,
	options: SemanticProfileOptions = {},
): Promise<void> {
	await ensureSemanticPackages("qcp semantic profile", ["semantic"]);
	const store = new SemanticStore();

	try {
		const environment = loadSemanticEnvironment(options);
		await syncSemanticSchema(store, environment);
		const table = resolveTableSelector(environment.schema, tableSelector);
		const profiler = new SemanticValueProfiler({
			store,
			databaseUrl: environment.connection.databaseUrl,
			sensitivePatterns: environment.activeConfig.sensitiveTablePatterns,
		});
		const spinner = ora(
			`Profiling values for ${formatTableId(table)}...`,
		).start();
		const result = await profiler.profile({
			connectionId: environment.connection.id,
			schemaName: table.schema,
			tableName: table.name,
			columnNames: options.columns,
			includeSensitive: options.includeSensitive ?? false,
			limit: options.limit,
		});
		spinner.succeed(`Profiled ${result.profiledColumns.length} column(s)`);

		await writeSemanticAuditEvent({
			context: auditContextForSemanticCommand(environment, "semantic profile"),
			action: "SEMANTIC_PROFILE",
			outcome: "success",
			metadata: {
				table: formatTableId(table),
				columnCount: result.profiledColumns.length,
				skippedCount: result.skippedColumns.length,
				includeSensitive: options.includeSensitive ?? false,
			},
		});

		printSuccess("Value profiles saved.");
		if (result.profiledColumns.length > 0) {
			printInfo(`Profiled: ${result.profiledColumns.join(", ")}`);
		}
		for (const skipped of result.skippedColumns) {
			printWarning(`Skipped ${skipped.columnName}: ${skipped.reason}`);
		}
	} catch (err: unknown) {
		printSemanticCommandError(err);
		process.exit(1);
	} finally {
		await store.close();
	}
}

export async function semanticMcpCommand(
	options: SemanticMcpOptions = {},
): Promise<void> {
	await ensureSemanticPackages("qcp semantic mcp", [
		"semantic",
		"semantic-mcp",
	]);
	const store = new SemanticStore();

	try {
		const environment = loadSemanticEnvironment(options);
		await syncSemanticSchema(store, environment);
		const service = new HumanSemanticQuestionService({
			store,
			mcpAdapter: new McpSemanticQuestionAdapter(),
		});
		const tools = createSemanticTools({
			store,
			connectionId: environment.connection.id,
			questionService: service,
			auditContext: auditContextForSemanticCommand(environment, "semantic mcp"),
		});
		await startSemanticMcpServer(tools);
	} catch (err: unknown) {
		printSemanticCommandError(err);
		process.exit(1);
	} finally {
		await store.close();
	}
}

async function ensureSemanticPackages(
	commandName: string,
	groups: readonly ("semantic" | "semantic-mcp")[],
): Promise<void> {
	await ensurePackageGroups({
		commandName,
		groups,
	});
}

function loadSemanticEnvironment(
	options: SemanticDatabaseOptions,
): SemanticEnvironment {
	const config = loadConfig();
	const connection = getActiveDatabaseConnection(config, options.database);
	if (!connection) {
		throw new SemanticCommandError(
			options.database
				? `Database connection not found: ${options.database}`
				: "No database connection configured. Run: qcp connect",
		);
	}
	const activeConfig = withActiveDatabaseConnection(config, connection);
	const schema = loadSchemaForConnection(connection).schema;

	return {
		config,
		activeConfig,
		connection,
		schema,
	};
}

async function syncSemanticSchema(
	store: SemanticStore,
	environment: SemanticEnvironment,
): Promise<SemanticSyncReport> {
	const indexer = new SemanticSchemaIndexer(store);
	return await indexer.sync(environment.connection, environment.schema);
}

async function filterEnrichmentObjects(options: {
	readonly store: SemanticStore;
	readonly connectionId: string;
	readonly schema: DatabaseSchema;
	readonly tableSelector?: string;
	readonly columnSelector?: string;
	readonly force: boolean;
}): Promise<SemanticObject[]> {
	const table = options.tableSelector
		? resolveTableSelector(options.schema, options.tableSelector)
		: undefined;
	const objects = await options.store.listObjects({
		connectionId: options.connectionId,
		activeOnly: true,
	});
	const annotations = await options.store.getLatestAnnotationMap(
		options.connectionId,
	);

	return objects.filter((object) => {
		if (table && object.schemaName !== table.schema) return false;
		if (table && object.tableName !== table.name) return false;
		if (options.columnSelector) {
			if (object.objectType !== "column") return false;
			if (object.columnName !== options.columnSelector) return false;
		}
		if (!options.force && annotations.has(object.id) && !object.stale) {
			return false;
		}
		return true;
	});
}

function resolveTableSelector(
	schema: DatabaseSchema,
	selector: string,
): SchemaTable {
	const parts = selector.split(".").filter((part) => part.length > 0);
	const matches =
		parts.length === 2
			? schema.tables.filter(
					(table) => table.schema === parts[0] && table.name === parts[1],
				)
			: schema.tables.filter((table) => table.name === selector);

	if (matches.length === 0) {
		throw new SemanticCommandError(
			`Table not found in schema catalog: ${selector}`,
		);
	}
	if (matches.length > 1) {
		throw new SemanticCommandError(
			`Table selector is ambiguous: ${selector}. Use schema.table.`,
		);
	}
	return matches[0];
}

function auditContextForSemanticCommand(
	environment: SemanticEnvironment,
	command: string,
): AuditContext {
	return {
		command,
		installId: environment.config.installId,
		connectionId: environment.connection.id,
		connectionName: environment.connection.name,
		databaseType: environment.connection.databaseType,
		databaseName: environment.schema.databaseName,
		provider: environment.activeConfig.provider,
		model: environment.activeConfig.model,
	};
}

function formatPercent(value: number, total: number): string {
	if (total === 0) return "0%";
	return `${Math.round((value / total) * 100)}%`;
}

function formatTableId(table: SchemaTable): string {
	return table.schema === "public"
		? table.name
		: `${table.schema}.${table.name}`;
}

function printSemanticCommandError(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	printError(message);
}
