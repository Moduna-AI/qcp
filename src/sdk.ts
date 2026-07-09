import {
	getActiveDatabaseConnection,
	getDatabaseUrl,
	loadConfig,
	withActiveDatabaseConnection,
} from "./config/index.js";
import {
	formatInstallCommand,
	getPackageGroupStatus,
	getPackageStoreDir,
	installPackageGroup,
	type PackageGroup,
	type PackageGroupStatus,
	providerPackageGroup,
} from "./packages/lazy-packages.js";
import { loadSchema, loadSchemaForConnection } from "./schema/index.js";
import { semanticStoreExists } from "./semantic/store.js";
import type {
	ActiveDatabaseConnection,
	ApprovalReason,
	DatabaseSchema,
	QcpConfig,
	SafetyLevel,
} from "./types/index.js";

export type QcpApprovalHandler = (
	reasons: readonly ApprovalReason[],
	sql: string,
) => Promise<boolean>;

export interface QcpClientOptions {
	readonly config?: QcpConfig;
	readonly connection?: ActiveDatabaseConnection;
	readonly connectionName?: string;
	readonly databaseUrl?: string;
	readonly schema?: DatabaseSchema;
	readonly packageStoreDir?: string;
	readonly installMissingPackages?: boolean;
	readonly semanticEnabled?: boolean;
	readonly safetyLevel?: SafetyLevel;
	readonly approvalHandler?: QcpApprovalHandler;
}

export interface QcpAskOptions {
	readonly config?: QcpConfig;
	readonly connection?: ActiveDatabaseConnection;
	readonly connectionName?: string;
	readonly databaseUrl?: string;
	readonly schema?: DatabaseSchema;
	readonly packageStoreDir?: string;
	readonly installMissingPackages?: boolean;
	readonly semanticEnabled?: boolean;
	readonly safetyLevel?: SafetyLevel;
	readonly approvalHandler?: QcpApprovalHandler;
}

export interface QcpAskResult {
	readonly text: string;
	readonly direct: boolean;
	readonly latencyMs: number;
	readonly tokensIn?: number;
	readonly tokensOut?: number;
	readonly connectionId?: string;
	readonly connectionName: string;
	readonly databaseName: string;
	readonly provider: QcpConfig["provider"];
	readonly model: string;
}

export interface QcpClient {
	ask(question: string, options?: QcpAskOptions): Promise<QcpAskResult>;
}

interface ResolvedSdkContext {
	readonly config: QcpConfig;
	readonly connection?: ActiveDatabaseConnection;
	readonly connectionId?: string;
	readonly connectionName: string;
	readonly databaseUrl: string;
	readonly schema: DatabaseSchema;
	readonly packageStoreDir?: string;
	readonly installMissingPackages: boolean;
	readonly semanticEnabled: boolean;
	readonly safetyLevel: SafetyLevel;
	readonly approvalHandler?: QcpApprovalHandler;
}

export class QcpSdkConfigurationError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "QcpSdkConfigurationError";
	}
}

export class QcpSdkRuntimeDependencyError extends Error {
	public readonly missingGroups: readonly PackageGroup[];
	public readonly statuses: readonly PackageGroupStatus[];
	public readonly installCommands: readonly string[];
	public readonly targetDir: string;

	public constructor(details: {
		readonly missingGroups: readonly PackageGroup[];
		readonly statuses: readonly PackageGroupStatus[];
		readonly targetDir: string;
		readonly cause?: unknown;
	}) {
		super(formatRuntimeDependencyMessage(details));
		this.name = "QcpSdkRuntimeDependencyError";
		this.missingGroups = details.missingGroups;
		this.statuses = details.statuses;
		this.installCommands = details.missingGroups.map(formatInstallCommand);
		this.targetDir = details.targetDir;
		if (details.cause !== undefined) {
			this.cause = details.cause;
		}
	}
}

export function createQcpClient(options: QcpClientOptions = {}): QcpClient {
	return {
		ask: (question, askOptions = {}) =>
			askWithSdkOptions(question, mergeOptions(options, askOptions)),
	};
}

export async function installQcpSdkRuntimePackages(
	options: Pick<
		QcpClientOptions,
		| "config"
		| "connection"
		| "connectionName"
		| "packageStoreDir"
		| "semanticEnabled"
	> = {},
): Promise<void> {
	const config = options.config ?? loadConfig();
	const connection =
		options.connection ??
		getActiveDatabaseConnection(config, options.connectionName);
	const databaseType = connection?.databaseType ?? config.databaseType;
	const semanticEnabled = options.semanticEnabled ?? semanticStoreExists();
	const groups = getSdkRuntimePackageGroups(
		config,
		databaseType,
		semanticEnabled,
	);
	for (const group of groups) {
		const result = await installPackageGroup({
			group,
			targetDir: options.packageStoreDir,
		});
		if (!result.ok) {
			const audit = auditSdkRuntimePackages(groups, options.packageStoreDir);
			throw new QcpSdkRuntimeDependencyError({
				missingGroups: audit.missingGroups,
				statuses: audit.statuses,
				targetDir: options.packageStoreDir ?? getPackageStoreDir(),
				cause: result.stderr || result.stdout,
			});
		}
	}
}

async function askWithSdkOptions(
	question: string,
	options: QcpClientOptions,
): Promise<QcpAskResult> {
	const context = resolveSdkContext(options);
	const groups = getSdkRuntimePackageGroups(
		context.config,
		context.config.databaseType,
		context.semanticEnabled,
	);
	const audit = auditSdkRuntimePackages(groups, context.packageStoreDir);
	if (audit.missingGroups.length > 0) {
		if (!context.installMissingPackages) {
			throw new QcpSdkRuntimeDependencyError({
				missingGroups: audit.missingGroups,
				statuses: audit.statuses,
				targetDir: context.packageStoreDir ?? getPackageStoreDir(),
			});
		}
		await installQcpSdkRuntimePackages({
			config: context.config,
			connection: context.connection,
			packageStoreDir: context.packageStoreDir,
			semanticEnabled: context.semanticEnabled,
		});
	}

	const { QcpSupervisorAgent } = await import("./agents/supervisor-agent.js");
	const supervisor = await QcpSupervisorAgent.create({
		config: context.config,
		command: "sdk",
		connectionId: context.connectionId,
		connectionName: context.connectionName,
		databaseUrl: context.databaseUrl,
		schema: context.schema,
		approvalHandler: context.approvalHandler
			? async (reasons, sql) => context.approvalHandler?.(reasons, sql) ?? false
			: undefined,
		semanticInteractive: false,
	});
	const response = await supervisor.generateResponse(question);

	return {
		text: response.text,
		direct: response.direct,
		latencyMs: response.latencyMs,
		tokensIn: response.tokensIn,
		tokensOut: response.tokensOut,
		connectionId: context.connectionId,
		connectionName: context.connectionName,
		databaseName: context.schema.databaseName,
		provider: context.config.provider,
		model: context.config.model,
	};
}

function resolveSdkContext(options: QcpClientOptions): ResolvedSdkContext {
	const config = options.config ?? loadConfig();
	const connection =
		options.connection ??
		getActiveDatabaseConnection(config, options.connectionName);
	const activeConfig = connection
		? withActiveDatabaseConnection(config, connection)
		: config;
	const databaseUrl =
		options.databaseUrl ??
		connection?.databaseUrl ??
		getDatabaseUrl(activeConfig);
	if (!databaseUrl) {
		throw new QcpSdkConfigurationError(
			"No database connection configured. Run `qcp connect` or pass `databaseUrl` and `schema` to createQcpClient().",
		);
	}

	const schema =
		options.schema ??
		(connection ? loadSchemaForConnection(connection).schema : loadSchema());

	return {
		config: options.databaseUrl
			? {
					...activeConfig,
					databaseUrl: options.databaseUrl,
					safetyLevel: options.safetyLevel ?? activeConfig.safetyLevel,
				}
			: {
					...activeConfig,
					safetyLevel: options.safetyLevel ?? activeConfig.safetyLevel,
				},
		connection,
		connectionId: connection?.id,
		connectionName: connection?.name ?? options.connectionName ?? "default",
		databaseUrl,
		schema,
		packageStoreDir: options.packageStoreDir,
		installMissingPackages: options.installMissingPackages ?? false,
		semanticEnabled: options.semanticEnabled ?? semanticStoreExists(),
		safetyLevel: options.safetyLevel ?? activeConfig.safetyLevel,
		approvalHandler: options.approvalHandler,
	};
}

function mergeOptions(
	clientOptions: QcpClientOptions,
	askOptions: QcpAskOptions,
): QcpClientOptions {
	return {
		...clientOptions,
		...askOptions,
	};
}

function getSdkRuntimePackageGroups(
	config: QcpConfig,
	databaseType: QcpConfig["databaseType"],
	semanticEnabled: boolean,
): PackageGroup[] {
	const groups: PackageGroup[] = [
		"agent",
		providerPackageGroup(config.provider),
	];
	if (databaseType === "prisma-postgres") groups.push("prisma");
	if (databaseType === "neon") groups.push("neon");
	if (semanticEnabled) groups.push("semantic");
	return [...new Set(groups)];
}

function auditSdkRuntimePackages(
	groups: readonly PackageGroup[],
	targetDir?: string,
): {
	readonly missingGroups: readonly PackageGroup[];
	readonly statuses: readonly PackageGroupStatus[];
} {
	const statuses = groups.map((group) =>
		getPackageGroupStatus(group, targetDir),
	);
	return {
		statuses,
		missingGroups: statuses
			.filter((status) => !status.installed)
			.map((status) => status.group),
	};
}

function formatRuntimeDependencyMessage(details: {
	readonly missingGroups: readonly PackageGroup[];
	readonly targetDir: string;
}): string {
	return [
		"Missing qcp SDK runtime packages.",
		`Missing groups: ${details.missingGroups.join(", ")}`,
		...details.missingGroups.map(
			(group) => `Install with: ${formatInstallCommand(group)}`,
		),
		`Target directory: ${details.targetDir}`,
	].join("\n");
}
