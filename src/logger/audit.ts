import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import winston from "winston";
import { LOGS_DIR } from "@/config/index.js";
import { sanitizeSensitiveData } from "@/safety/index.js";
import type { DatabaseType, ProviderName } from "@/types/index.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
	| JsonPrimitive
	| { readonly [key: string]: JsonValue }
	| readonly JsonValue[];

export type AuditScope =
	| "auth"
	| "data_access"
	| "schema_change"
	| "system_admin";

export type AuditAction =
	| "READ"
	| "EXPLAIN"
	| "LOGIN_SUCCESS"
	| "LOGIN_FAILED"
	| "CONFIG_CHANGE"
	| "CONNECTION_CHANGE"
	| "SCHEMA_SCAN"
	| "QUERY_REJECTED"
	| "APPROVAL_GRANTED"
	| "APPROVAL_DENIED"
	| "APPROVAL_REQUIRED"
	| "SEMANTIC_SCAN"
	| "SEMANTIC_ANNOTATION"
	| "SEMANTIC_PROFILE"
	| "AUDIT_INTEGRITY_FAILURE";

export type AuditOutcome = "success" | "failure" | "rejected" | "cancelled";

export interface AuditActor {
	readonly userId: string;
	readonly username: string;
	readonly uid?: number;
	readonly hostname: string;
	readonly processId: number;
	readonly installId: string;
}

export interface AuditResource {
	readonly command?: string;
	readonly sessionId?: string;
	readonly connectionId?: string;
	readonly connectionName?: string;
	readonly databaseType?: DatabaseType;
	readonly databaseName?: string;
	readonly provider?: ProviderName;
	readonly model?: string;
	readonly statementType?: string;
	readonly tables?: readonly string[];
	readonly sql?: string;
	readonly [key: string]: JsonValue | undefined;
}

export interface AuditDelta {
	readonly before: JsonValue;
	readonly after: JsonValue;
}

export interface AuditEventInput {
	readonly scope: AuditScope;
	readonly action: AuditAction;
	readonly actor: AuditActor;
	readonly resource: AuditResource;
	readonly delta: AuditDelta | null;
	readonly outcome: AuditOutcome;
	readonly metadata?: JsonValue;
}

export interface AuditRecord extends AuditEventInput {
	readonly timestamp: string;
	readonly previousHash: string | null;
	readonly eventHash: string;
}

export interface AuditContext {
	readonly logsDir?: string;
	readonly command?: string;
	readonly sessionId?: string;
	readonly installId: string;
	readonly connectionId?: string;
	readonly connectionName?: string;
	readonly databaseType?: DatabaseType;
	readonly databaseName?: string;
	readonly provider?: ProviderName;
	readonly model?: string;
}

export interface AuditWriteOptions {
	readonly logsDir?: string;
	readonly now?: () => Date;
}

export type AuditWriteResult =
	| {
			readonly ok: true;
			readonly record: AuditRecord;
	  }
	| {
			readonly ok: false;
			readonly error: string;
	  };

interface AuditManifest {
	readonly version: 1;
	readonly latestHash: string;
	readonly eventCount: number;
	readonly updatedAt: string;
}

const AUDIT_LOG_FILE = "audit.jsonl";
const AUDIT_MANIFEST_FILE = "audit-manifest.json";
const INITIAL_HASH = "GENESIS";

const auditLineFormat = winston.format.printf(({ message }) => String(message));

export async function writeAuditEvent(
	input: AuditEventInput,
	options: AuditWriteOptions = {},
): Promise<AuditWriteResult> {
	try {
		const logsDir = options.logsDir ?? LOGS_DIR;
		ensureAuditDir(logsDir);

		const auditPath = join(logsDir, AUDIT_LOG_FILE);
		const manifestPath = join(logsDir, AUDIT_MANIFEST_FILE);
		const manifest = readAuditManifest(manifestPath);
		const lastRecord = readLastAuditRecord(auditPath);
		const previousHash = lastRecord?.eventHash ?? null;
		const currentEventCount =
			manifest?.eventCount ?? countAuditLines(auditPath);
		const timestamp = (options.now ?? (() => new Date()))().toISOString();

		if (manifest && manifest.latestHash !== (previousHash ?? INITIAL_HASH)) {
			appendIntegrityFailureEvent({
				logsDir,
				actor: input.actor,
				timestamp,
				expectedHash: manifest.latestHash,
				actualHash: previousHash ?? INITIAL_HASH,
			});
			return {
				ok: false,
				error:
					"Audit integrity check failed. Manifest does not match audit log tail.",
			};
		}

		const sanitized = sanitizeAuditInput(input);
		const hashPayload = {
			...sanitized,
			timestamp,
			previousHash,
		};
		const eventHash = hashAuditPayload(hashPayload);
		const record: AuditRecord = {
			...sanitized,
			timestamp,
			previousHash,
			eventHash,
		};
		const line = `${formatAuditLine(record)}\n`;

		await appendAuditLine(logsDir, line);
		writeFileSync(
			manifestPath,
			`${JSON.stringify(
				{
					version: 1,
					latestHash: eventHash,
					eventCount: currentEventCount + 1,
					updatedAt: timestamp,
				} satisfies AuditManifest,
				null,
				2,
			)}\n`,
			"utf-8",
		);

		return { ok: true, record };
	} catch (err: unknown) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : "Audit write failed.",
		};
	}
}

function appendIntegrityFailureEvent(options: {
	readonly logsDir: string;
	readonly actor: AuditActor;
	readonly timestamp: string;
	readonly expectedHash: string;
	readonly actualHash: string;
}): void {
	try {
		const event: AuditEventInput = {
			scope: "system_admin",
			action: "AUDIT_INTEGRITY_FAILURE",
			actor: options.actor,
			resource: {
				command: "audit",
			},
			delta: null,
			outcome: "failure",
			metadata: {
				expectedHash: options.expectedHash,
				actualHash: options.actualHash,
			},
		};
		const sanitized = sanitizeAuditInput(event);
		const previousHash =
			options.actualHash === INITIAL_HASH ? null : options.actualHash;
		const eventHash = hashAuditPayload({
			...sanitized,
			timestamp: options.timestamp,
			previousHash,
		});
		const record: AuditRecord = {
			...sanitized,
			timestamp: options.timestamp,
			previousHash,
			eventHash,
		};
		appendFileSync(
			join(options.logsDir, AUDIT_LOG_FILE),
			`${formatAuditLine(record)}\n`,
			"utf-8",
		);
	} catch {
		// Integrity failure reporting must not crash the CLI.
	}
}

export function resolveAuditActor(installId: string): AuditActor {
	const info = safeUserInfo();
	const username = info.username || "unknown";

	return {
		userId: `${username}@${hostname()}`,
		username,
		uid: info.uid,
		hostname: hostname(),
		processId: process.pid,
		installId,
	};
}

export function buildAuditResource(context: AuditContext): AuditResource {
	return {
		command: context.command,
		sessionId: context.sessionId,
		connectionId: context.connectionId,
		connectionName: context.connectionName,
		databaseType: context.databaseType,
		databaseName: context.databaseName,
		provider: context.provider,
		model: context.model,
	};
}

export function extractSqlTables(sql: string): string[] {
	const tables = new Set<string>();
	const patterns = [
		/\bfrom\s+("?[\w.-]+"?(?:\."?[\w-]+"?)?)/gi,
		/\bjoin\s+("?[\w.-]+"?(?:\."?[\w-]+"?)?)/gi,
	] as const;

	for (const pattern of patterns) {
		for (const match of sql.matchAll(pattern)) {
			const table = match[1]?.replaceAll('"', "");
			if (table) tables.add(table);
		}
	}

	return [...tables].sort();
}

function ensureAuditDir(logsDir: string): void {
	if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
}

async function appendAuditLine(logsDir: string, line: string): Promise<void> {
	appendFileSync(join(logsDir, AUDIT_LOG_FILE), line, "utf-8");
}

function readAuditManifest(path: string): AuditManifest | null {
	if (!existsSync(path)) return null;

	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		return isAuditManifest(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function readLastAuditRecord(path: string): AuditRecord | null {
	if (!existsSync(path)) return null;

	const lines = readFileSync(path, "utf-8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const last = lines.at(-1);
	if (!last) return null;

	try {
		const parsed = JSON.parse(last);
		return isAuditRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function countAuditLines(path: string): number {
	if (!existsSync(path)) return 0;
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0).length;
}

function hashAuditPayload(payload: unknown): string {
	return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function sanitizeAuditInput(input: AuditEventInput): AuditEventInput {
	const sanitized = redactDatabaseUrls(
		sanitizeSensitiveData({
			scope: input.scope,
			action: input.action,
			resource: input.resource,
			delta: input.delta,
			outcome: input.outcome,
			metadata: input.metadata,
		}),
	) as Omit<AuditEventInput, "actor">;

	return {
		...sanitized,
		actor: input.actor,
	};
}

function redactDatabaseUrls(value: unknown): unknown {
	if (typeof value === "string") return redactDatabaseUrlString(value);
	if (Array.isArray(value))
		return value.map((item) => redactDatabaseUrls(item));
	if (isRecord(value)) {
		const redacted: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			redacted[key] = redactDatabaseUrls(item);
		}
		return redacted;
	}
	return value;
}

function redactDatabaseUrlString(value: string): string {
	return value
		.replace(
			/\b(?:postgres(?:ql)?):\/\/[^\s'"<>]+/gi,
			"[REDACTED_DATABASE_URL]",
		)
		.replace(
			/\b(DATABASE_URL|QCP_DATABASE_URL|PRISMA_DATABASE_URL)=\S+/g,
			"$1=[REDACTED_DATABASE_URL]",
		);
}

function formatAuditLine(record: AuditRecord): string {
	const message = stableStringify(record);
	const transformed = auditLineFormat.transform(
		{ level: "info", message },
		auditLineFormat.options,
	);
	const symbolMessage = Symbol.for("message");

	if (isSymbolRecord(transformed)) {
		const formatted = transformed[symbolMessage];
		if (typeof formatted === "string") return formatted;
	}

	return message;
}

function stableStringify(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort();
		return `{${keys
			.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
			.join(",")}}`;
	}
	return "null";
}

function safeUserInfo(): { readonly username: string; readonly uid?: number } {
	try {
		const info = userInfo();
		return {
			username: info.username,
			uid: typeof info.uid === "number" ? info.uid : undefined,
		};
	} catch {
		return { username: "unknown" };
	}
}

function isAuditManifest(value: unknown): value is AuditManifest {
	if (!isRecord(value)) return false;
	return (
		value.version === 1 &&
		typeof value.latestHash === "string" &&
		typeof value.eventCount === "number" &&
		typeof value.updatedAt === "string"
	);
}

function isAuditRecord(value: unknown): value is AuditRecord {
	if (!isRecord(value)) return false;
	return (
		typeof value.timestamp === "string" &&
		typeof value.eventHash === "string" &&
		(value.previousHash === null || typeof value.previousHash === "string")
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isSymbolRecord(
	value: unknown,
): value is Record<string | symbol, unknown> {
	return typeof value === "object" && value !== null;
}
