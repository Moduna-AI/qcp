import type { ToolsInput } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { DatabaseConnectionRegistry } from "@/config/database-connection-registry.js";
import { loadConfig } from "@/config/index.js";
import { schemaCatalogHasConnection } from "@/schema/index.js";
import type { DatabaseConnectionConfig, QcpConfig } from "@/types/index.js";

const redactedUrlSummarySchema = z.object({
	protocol: z.string().optional(),
	host: z.string().optional(),
	port: z.string().optional(),
	database: z.string().optional(),
	user: z.string().optional(),
	password: z.literal("[REDACTED]").optional(),
	parseable: z.boolean(),
});

const configConnectionSchema = z.object({
	id: z.string(),
	name: z.string(),
	databaseType: z.string(),
	active: z.boolean(),
	schemaIndexed: z.boolean(),
	prismaSchemaPath: z.string().optional(),
	prismaDatasourceName: z.string().optional(),
	createdAt: z.string(),
	updatedAt: z.string(),
	url: redactedUrlSummarySchema,
});

const configContextSchema = z.object({
	config: z.object({
		provider: z.string(),
		model: z.string(),
		safetyLevel: z.enum(["low", "standard", "strict"]),
		safeMode: z.boolean(),
		showSql: z.boolean(),
		showMetrics: z.boolean(),
		telemetry: z.boolean(),
	}),
	activeConnection: configConnectionSchema.optional(),
	connections: z.array(configConnectionSchema),
	commands: z.object({
		listConnections: z.string(),
		showConfig: z.string(),
		switchConnection: z.string(),
		addConnection: z.string(),
		editConnection: z.string(),
		removeConnection: z.string(),
		scanSchema: z.string(),
	}),
});

export interface ConfigToolDependencies {
	readonly loadConfig: () => QcpConfig;
	readonly schemaCatalogHasConnection: (connectionId: string) => boolean;
}

export interface CreateConfigToolsOptions {
	readonly dependencies?: Partial<ConfigToolDependencies>;
}

export type ConfigContext = z.infer<typeof configContextSchema>;

export function createConfigTools(
	options: CreateConfigToolsOptions = {},
): ToolsInput {
	const dependencies: ConfigToolDependencies = {
		loadConfig,
		schemaCatalogHasConnection,
		...options.dependencies,
	};

	return {
		qcp_read_config_context: createTool({
			id: "qcp_read_config_context",
			description:
				"Read redacted qcp configuration and database connection metadata. Use this for questions about connected databases, the active database, schema indexing, model/provider settings, safety settings, and which CLI commands change config.",
			inputSchema: z.object({}),
			outputSchema: configContextSchema,
			mcp: {
				annotations: {
					title: "Read QCP Config Context",
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: false,
				},
			},
			execute: async () => buildConfigContext(dependencies),
		}),
	};
}

export function buildConfigContext(
	dependencies: ConfigToolDependencies = {
		loadConfig,
		schemaCatalogHasConnection,
	},
): ConfigContext {
	const config = dependencies.loadConfig();
	const registry = new DatabaseConnectionRegistry(config);
	const active = registry.getActive();
	const connections = registry
		.list()
		.map((connection) =>
			formatConnection(connection, active?.id, dependencies),
		);

	return {
		config: {
			provider: config.provider,
			model: config.model,
			safetyLevel: config.safetyLevel,
			safeMode: config.safeMode,
			showSql: config.showSql,
			showMetrics: config.showMetrics,
			telemetry: config.telemetry,
		},
		activeConnection: connections.find((connection) => connection.active),
		connections,
		commands: {
			listConnections: "qcp db list",
			showConfig: "qcp config show",
			switchConnection: "qcp db use <alias>",
			addConnection: "qcp connect --name <alias> <postgres-url>",
			editConnection: "qcp db edit <alias>",
			removeConnection: "qcp db remove <alias>",
			scanSchema: "qcp schema scan --database <alias>",
		},
	};
}

function formatConnection(
	connection: DatabaseConnectionConfig,
	activeDatabaseId: string | undefined,
	dependencies: ConfigToolDependencies,
): ConfigContext["connections"][number] {
	return {
		id: connection.id,
		name: connection.name,
		databaseType: connection.databaseType,
		active: connection.id === activeDatabaseId,
		schemaIndexed: dependencies.schemaCatalogHasConnection(connection.id),
		prismaSchemaPath: connection.prismaSchemaPath,
		prismaDatasourceName: connection.prismaDatasourceName,
		createdAt: connection.createdAt,
		updatedAt: connection.updatedAt,
		url: redactDatabaseUrl(connection.databaseUrl),
	};
}

export function redactDatabaseUrl(
	databaseUrl: string,
): ConfigContext["connections"][number]["url"] {
	try {
		const parsed = new URL(databaseUrl);
		const database = parsed.pathname.replace(/^\//, "") || undefined;
		return {
			protocol: parsed.protocol.replace(/:$/, ""),
			host: parsed.hostname || undefined,
			port: parsed.port || undefined,
			database,
			user: parsed.username || undefined,
			password: parsed.password ? "[REDACTED]" : undefined,
			parseable: true,
		};
	} catch {
		return {
			parseable: false,
		};
	}
}
