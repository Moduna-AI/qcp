import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseToolApprovalHandler } from "./agents/database-tools.js";
import type { QcpSupervisorAgent } from "./agents/supervisor-agent.js";
import {
	getActiveDatabaseConnection,
	loadConfig,
	saveConfig,
	withActiveDatabaseConnection,
} from "./config/index.js";
import {
	formatInstallCommand,
	getPackageStoreDir,
	type PackageGroup,
	type PackageGroupStatus,
	providerPackageGroup,
} from "./packages/lazy-packages.js";
import {
	auditPackageGroups,
	installMissingPackageGroups,
} from "./packages/runtime.js";
import {
	loadSchemaForConnection,
	schemaCatalogHasConnection,
} from "./schema/index.js";
import { semanticStoreExists } from "./semantic/store.js";
import type {
	ActiveDatabaseConnection,
	DatabaseSchema,
	QcpConfig,
	QcpWebAuthConfig,
	SafetyLevel,
} from "./types/index.js";

export type { QcpSupervisorAgent } from "./agents/supervisor-agent.js";

const DEFAULT_WEB_SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const WEB_AUTH_WINDOW_MS = 1000 * 60 * 5;
const WEB_AUTH_MAX_FAILURES = 5;
const webAuthFailures = new Map<string, number[]>();

export interface QcpWebAuthSetup {
	readonly created: boolean;
	readonly configured: boolean;
}

export interface QcpWebConnectionSummary {
	readonly id: string;
	readonly name: string;
	readonly databaseType: QcpConfig["databaseType"];
	readonly active: boolean;
	readonly schemaAvailable: boolean;
	readonly databaseName?: string;
	readonly tableCount?: number;
}

export interface QcpWebSafetyConfig {
	readonly safetyLevel: SafetyLevel;
}

export interface QcpWebResolvedConnection {
	readonly config: QcpConfig;
	readonly connection: ActiveDatabaseConnection;
	readonly schema: DatabaseSchema;
}

export interface QcpWebSupervisorSession extends QcpWebResolvedConnection {
	readonly supervisor: QcpSupervisorAgent;
}

export class QcpWebAuthError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "QcpWebAuthError";
	}
}

export class QcpWebConfigurationError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "QcpWebConfigurationError";
	}
}

export class QcpWebRuntimeDependencyError extends Error {
	public readonly missingGroups: readonly PackageGroup[];
	public readonly statuses: readonly PackageGroupStatus[];
	public readonly installCommands: readonly string[];
	public readonly targetDir: string;

	public constructor(details: {
		readonly missingGroups: readonly PackageGroup[];
		readonly statuses: readonly PackageGroupStatus[];
		readonly targetDir: string;
	}) {
		super(formatRuntimeDependencyMessage(details));
		this.name = "QcpWebRuntimeDependencyError";
		this.missingGroups = details.missingGroups;
		this.statuses = details.statuses;
		this.installCommands = details.missingGroups.map(formatInstallCommand);
		this.targetDir = details.targetDir;
	}
}

export function ensureQcpWebAuthSetup(): QcpWebAuthSetup {
	return {
		created: false,
		configured: isQcpWebAuthConfigured(),
	};
}

export function isQcpWebAuthConfigured(
	config: QcpConfig = loadConfig(),
): boolean {
	return Boolean(config.webAuth);
}

export function initializeQcpWebAuth(passcode: string): {
	readonly created: boolean;
} {
	const trimmedPasscode = passcode.trim();
	if (!/^\d{4}$/.test(trimmedPasscode)) {
		throw new QcpWebAuthError("qcp-web passcode must be exactly 4 digits.");
	}
	const config = loadConfig();
	if (config.webAuth) {
		throw new QcpWebAuthError("qcp-web auth is already initialized.");
	}

	const webAuth = createWebAuthConfig(trimmedPasscode);
	saveConfig({ ...config, webAuth });
	return {
		created: true,
	};
}

export function loginQcpWeb(passcode: string): {
	readonly token: string;
	readonly expiresAt: string;
} {
	assertWebAuthAttemptAllowed("login");
	const normalizedPasscode = passcode.trim();
	const config = loadConfig();
	const webAuth = config.webAuth;
	if (!webAuth) {
		throw new QcpWebAuthError("qcp-web auth is not initialized.");
	}
	if (
		!verifySecret(
			normalizedPasscode,
			webAuth.passcodeSalt,
			webAuth.passcodeHash,
		)
	) {
		recordWebAuthFailure("login");
		throw new QcpWebAuthError("Authentication failed.");
	}
	clearWebAuthFailures("login");

	const token = generateToken(32);
	const now = new Date();
	const expiresAt = new Date(now.getTime() + DEFAULT_WEB_SESSION_TTL_MS);
	saveConfig({
		...config,
		webAuth: {
			...webAuth,
			sessionTokenHash: hashSecret(token, webAuth.passcodeSalt),
			sessionExpiresAt: expiresAt.toISOString(),
			updatedAt: now.toISOString(),
		},
	});

	return {
		token,
		expiresAt: expiresAt.toISOString(),
	};
}

export function validateQcpWebSession(
	token: string | undefined,
	config: QcpConfig = loadConfig(),
): boolean {
	if (!token) return false;
	const webAuth = config.webAuth;
	if (!webAuth?.sessionTokenHash || !webAuth.sessionExpiresAt) return false;
	const expiresAt = Date.parse(webAuth.sessionExpiresAt);
	if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;
	return verifySecret(token, webAuth.passcodeSalt, webAuth.sessionTokenHash);
}

export function reauthenticateQcpWebSafetyDowngrade(passcode: string): void {
	assertWebAuthAttemptAllowed("safety-downgrade");
	const webAuth = loadConfig().webAuth;
	const valid = Boolean(
		webAuth &&
			verifySecret(passcode.trim(), webAuth.passcodeSalt, webAuth.passcodeHash),
	);
	if (!valid) {
		recordWebAuthFailure("safety-downgrade");
		throw new QcpWebAuthError("Authentication failed.");
	}
	clearWebAuthFailures("safety-downgrade");
}

export function logoutQcpWeb(): void {
	const config = loadConfig();
	if (!config.webAuth) return;
	saveConfig({
		...config,
		webAuth: {
			...config.webAuth,
			sessionTokenHash: undefined,
			sessionExpiresAt: undefined,
			updatedAt: new Date().toISOString(),
		},
	});
}

export function listQcpWebConnections(
	config: QcpConfig = loadConfig(),
): QcpWebConnectionSummary[] {
	const active = getActiveDatabaseConnection(config);
	return config.databaseConnections
		.map((connection) => {
			const schemaAvailable = schemaCatalogHasConnection(connection.id);
			const schema = schemaAvailable
				? loadSchemaForConnection({
						id: connection.id,
						name: connection.name,
						databaseType: connection.databaseType,
						databaseUrl: connection.databaseUrl,
						prismaSchemaPath: connection.prismaSchemaPath,
						prismaDatasourceName: connection.prismaDatasourceName,
					}).schema
				: undefined;
			return {
				id: connection.id,
				name: connection.name,
				databaseType: connection.databaseType,
				active: active?.id === connection.id,
				schemaAvailable,
				databaseName: schema?.databaseName,
				tableCount: schema?.tableCount,
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

export function getQcpWebSafetyConfig(
	config: QcpConfig = loadConfig(),
): QcpWebSafetyConfig {
	return {
		safetyLevel: config.safetyLevel,
	};
}

export function updateQcpWebSafetyLevel(
	safetyLevel: SafetyLevel,
): QcpWebSafetyConfig {
	const config = loadConfig();
	const updated = saveConfig({
		...config,
		safetyLevel,
		safeMode: safetyLevel !== "low",
	});
	return getQcpWebSafetyConfig(updated);
}

export function resolveQcpWebConnection(
	connectionName?: string,
	config: QcpConfig = loadConfig(),
): QcpWebResolvedConnection {
	const connection = getActiveDatabaseConnection(config, connectionName);
	if (!connection) {
		throw new QcpWebConfigurationError(
			"No database connection configured. Run: qcp connect",
		);
	}

	let schema: DatabaseSchema;
	try {
		schema = loadSchemaForConnection(connection).schema;
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		throw new QcpWebConfigurationError(`${message}\nRun: qcp schema scan`);
	}

	return {
		config: withActiveDatabaseConnection(config, connection),
		connection,
		schema,
	};
}

export async function createQcpWebSupervisor(options: {
	readonly connectionName?: string;
	readonly sessionId: string;
	readonly safetyLevel?: SafetyLevel;
	readonly approvalHandler?: DatabaseToolApprovalHandler;
}): Promise<QcpWebSupervisorSession> {
	const resolved = resolveQcpWebConnection(options.connectionName);
	const config = {
		...resolved.config,
		safetyLevel: options.safetyLevel ?? resolved.config.safetyLevel,
	};
	await installMissingPackageGroups({
		commandName: "qcp-web",
		groups: getQcpWebRuntimePackageGroups(
			config,
			config.databaseType,
			semanticStoreExists(),
		),
	});

	const audit = auditQcpWebRuntimePackages(config, config.databaseType);
	if (audit.missingGroups.length > 0) {
		throw new QcpWebRuntimeDependencyError({
			missingGroups: audit.missingGroups,
			statuses: audit.statuses,
			targetDir: getPackageStoreDir(),
		});
	}

	const { QcpSupervisorAgent } = await import("./agents/supervisor-agent.js");
	const supervisor = await QcpSupervisorAgent.create({
		config,
		command: "web",
		sessionId: options.sessionId,
		connectionId: resolved.connection.id,
		connectionName: resolved.connection.name,
		databaseUrl: resolved.connection.databaseUrl,
		schema: resolved.schema,
		approvalHandler: options.approvalHandler,
		semanticInteractive: false,
	});

	return {
		...resolved,
		config,
		supervisor,
	};
}

export function auditQcpWebRuntimePackages(
	config: QcpConfig = loadConfig(),
	databaseType: QcpConfig["databaseType"] = config.databaseType,
): {
	readonly missingGroups: readonly PackageGroup[];
	readonly statuses: readonly PackageGroupStatus[];
} {
	const groups = getQcpWebRuntimePackageGroups(
		config,
		databaseType,
		semanticStoreExists(),
	);
	const audit = auditPackageGroups(groups);
	return {
		statuses: audit.statuses,
		missingGroups: audit.missingGroups,
	};
}

function createWebAuthConfig(passcode: string): QcpWebAuthConfig {
	const now = new Date().toISOString();
	const passcodeSalt = generateToken(16);
	return {
		passcodeHash: hashSecret(passcode, passcodeSalt),
		passcodeSalt,
		createdAt: now,
		updatedAt: now,
	};
}

function getQcpWebRuntimePackageGroups(
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

function generateToken(byteLength: number): string {
	return randomBytes(byteLength).toString("base64url");
}

function hashSecret(secret: string, salt: string): string {
	return createHash("sha256").update(`${salt}:${secret}`).digest("hex");
}

function verifySecret(
	secret: string,
	salt: string,
	expectedHash: string,
): boolean {
	const actual = Buffer.from(hashSecret(secret, salt), "utf8");
	const expected = Buffer.from(expectedHash, "utf8");
	if (actual.length !== expected.length) return false;
	return timingSafeEqual(actual, expected);
}

function assertWebAuthAttemptAllowed(scope: string): void {
	const cutoff = Date.now() - WEB_AUTH_WINDOW_MS;
	const attempts = (webAuthFailures.get(scope) ?? []).filter(
		(timestamp) => timestamp > cutoff,
	);
	webAuthFailures.set(scope, attempts);
	if (attempts.length >= WEB_AUTH_MAX_FAILURES) {
		throw new QcpWebAuthError("Authentication failed.");
	}
}

function recordWebAuthFailure(scope: string): void {
	const attempts = webAuthFailures.get(scope) ?? [];
	webAuthFailures.set(
		scope,
		[...attempts, Date.now()].slice(-WEB_AUTH_MAX_FAILURES),
	);
}

function clearWebAuthFailures(scope: string): void {
	webAuthFailures.delete(scope);
}

function formatRuntimeDependencyMessage(details: {
	readonly missingGroups: readonly PackageGroup[];
	readonly targetDir: string;
}): string {
	return [
		"Missing qcp-web runtime packages.",
		`Missing groups: ${details.missingGroups.join(", ")}`,
		...details.missingGroups.map(
			(group) => `Install with: ${formatInstallCommand(group)}`,
		),
		`Target directory: ${details.targetDir}`,
	].join("\n");
}
