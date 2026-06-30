import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import "dotenv/config";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { DatabaseType, ProviderName, QcpConfig } from "@/types/index.js";

// ─── Paths ────────────────────────────────────────────────────────────────────

export const QCP_HOME = join(homedir(), ".qcp");
export const CONFIG_PATH = join(QCP_HOME, "config.json");
export const LOGS_DIR = join(QCP_HOME, "logs");
export const LOCAL_QCP_DIR = ".qcp";
export const LOCAL_SCHEMA_PATH = join(LOCAL_QCP_DIR, "schema.json");
export const LOCAL_SUPPORT_DIR = join(LOCAL_QCP_DIR, "support");

// ─── Schema ───────────────────────────────────────────────────────────────────

const ApiKeysSchema = z.object({
	gemini: z.string().optional(),
	openai: z.string().optional(),
	anthropic: z.string().optional(),
});

export const DATABASE_TYPES = [
	"prisma-postgres",
	"neon",
	"supabase",
	"oracle-postgres",
	"other-postgres",
] as const satisfies readonly DatabaseType[];

const DatabaseTypeSchema = z.enum(DATABASE_TYPES);

const QcpConfigSchema = z.object({
	version: z.string().default("0.1.0"),
	installId: z.string().default(() => uuidv7()),
	databaseType: DatabaseTypeSchema.default("other-postgres"),
	databaseUrl: z.string().optional(),
	prismaSchemaPath: z.string().optional(),
	prismaDatasourceName: z.string().optional(),
	provider: z
		.enum(["gemini", "openai", "anthropic", "ollama"])
		.default("gemini"),
	model: z.string().default("gemini-2.5-flash"),
	telemetry: z.boolean().default(true),
	safeMode: z.boolean().default(true),
	showSql: z.boolean().default(true),
	showMetrics: z.boolean().default(false),
	sensitiveTablePatterns: z
		.array(z.string())
		.default([
			"user",
			"customer",
			"payment",
			"billing",
			"payroll",
			"employee",
			"password",
			"token",
			"secret",
			"credential",
		]),
	ollamaHost: z.string().optional(),
	apiKeys: ApiKeysSchema.default({}),
});

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_MODELS: Record<ProviderName, string> = {
	gemini: "gemini-2.5-flash",
	openai: "gpt-5.5",
	anthropic: "claude-opus-4-8",
	ollama: "qwen3",
};

export const AVAILABLE_MODELS: Record<ProviderName, string[]> = {
	gemini: [
		"gemini-3.5-flash",
		"gemini-3.1-flash-lite",
		"gemini-2.5-flash",
		"gemini-2.5-pro",
	],
	openai: [
		"gpt-5.5-pro",
		"gpt-5.5",
		"gpt-5.4-pro",
		"gpt-5.4",
		"gpt-5.4-mini",
		"gpt-5.4-nano",
		"gpt-4.1",
		"gpt-4.1-mini",
	],
	anthropic: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
	ollama: ["qwen3", "llama3", "mistral", "codellama", "phi3"],
};

// ─── Read / Write ──────────────────────────────────────────────────────────────

export function ensureConfigDir(): void {
	if (!existsSync(QCP_HOME)) {
		mkdirSync(QCP_HOME, { recursive: true });
	}
	if (!existsSync(LOGS_DIR)) {
		mkdirSync(LOGS_DIR, { recursive: true });
	}
}

export function configExists(): boolean {
	return existsSync(CONFIG_PATH);
}

export function loadConfig(): QcpConfig {
	ensureConfigDir();

	if (!existsSync(CONFIG_PATH)) {
		return createDefaultConfig();
	}

	try {
		const raw = readFileSync(CONFIG_PATH, "utf-8");
		const parsed = JSON.parse(raw);
		const result = QcpConfigSchema.safeParse(parsed);
		if (!result.success) {
			console.warn(
				"Config validation warning; using defaults for invalid fields.",
			);
			return parseQcpConfig(parsed);
		}
		return result.data as QcpConfig;
	} catch {
		return createDefaultConfig();
	}
}

export function saveConfig(config: Partial<QcpConfig>): QcpConfig {
	ensureConfigDir();
	const current = configExists() ? loadConfig() : createDefaultConfig();
	const merged = { ...current, ...config };
	const validated = QcpConfigSchema.parse(merged) as QcpConfig;
	writeFileSync(CONFIG_PATH, JSON.stringify(validated, null, 2));
	return validated;
}

export function createDefaultConfig(): QcpConfig {
	const config = QcpConfigSchema.parse({}) as QcpConfig;
	return config;
}

export function parseQcpConfig(config: unknown): QcpConfig {
	return QcpConfigSchema.parse(config) as QcpConfig;
}

// ─── Getters / Setters ────────────────────────────────────────────────────────

export function getApiKey(config: QcpConfig): string | undefined {
	switch (config.provider) {
		case "gemini":
			return config.apiKeys.gemini ?? process.env.GEMINI_API_KEY;
		case "openai":
			return config.apiKeys.openai ?? process.env.OPENAI_API_KEY;
		case "anthropic":
			return config.apiKeys.anthropic ?? process.env.ANTHROPIC_API_KEY;
		case "ollama":
			return "ollama"; // no key needed
		default:
			return undefined;
	}
}

export function setApiKey(provider: ProviderName, key: string): void {
	const config = loadConfig();
	config.apiKeys[provider as keyof typeof config.apiKeys] = key;
	saveConfig(config);
}

export function getDatabaseUrl(config: QcpConfig): string | undefined {
	if (config.databaseType === "prisma-postgres") {
		return (
			process.env.PRISMA_DATABASE_URL ??
			config.databaseUrl ??
			process.env.DATABASE_URL ??
			process.env.QCP_DATABASE_URL
		);
	}

	return (
		config.databaseUrl ??
		process.env.DATABASE_URL ??
		process.env.QCP_DATABASE_URL
	);
}

export function isDatabaseType(value: string): value is DatabaseType {
	return DATABASE_TYPES.includes(value as DatabaseType);
}

export function inferDatabaseType(
	databaseUrl: string,
	fallback: DatabaseType = "other-postgres",
): DatabaseType {
	const lowerUrl = databaseUrl.toLowerCase();

	if (lowerUrl.includes("prisma.io") || lowerUrl.includes("prisma-data.net")) {
		return "prisma-postgres";
	}

	if (lowerUrl.includes("neon.tech") || lowerUrl.includes("neon.build")) {
		return "neon";
	}

	if (
		lowerUrl.includes("supabase.co") ||
		lowerUrl.includes("pooler.supabase.com")
	) {
		return "supabase";
	}

	if (
		lowerUrl.includes("oraclecloud.com") ||
		lowerUrl.includes("oci.oraclecloud.com")
	) {
		return "oracle-postgres";
	}

	return fallback;
}

// ─── Local project helpers ────────────────────────────────────────────────────

export function ensureLocalDir(): void {
	if (!existsSync(LOCAL_QCP_DIR)) {
		mkdirSync(LOCAL_QCP_DIR, { recursive: true });
	}
}

export function localSchemaExists(): boolean {
	return existsSync(LOCAL_SCHEMA_PATH);
}

// ─── Redaction (for support bundles) ─────────────────────────────────────────

export function redactConfig(config: QcpConfig): Record<string, unknown> {
	return {
		version: config.version,
		installId: config.installId,
		databaseType: config.databaseType,
		provider: config.provider,
		model: config.model,
		telemetry: config.telemetry,
		safeMode: config.safeMode,
		showSql: config.showSql,
		showMetrics: config.showMetrics,
		databaseUrl: config.databaseUrl ? "[REDACTED]" : undefined,
		prismaSchemaPath: config.prismaSchemaPath,
		prismaDatasourceName: config.prismaDatasourceName,
		apiKeys: {
			gemini: config.apiKeys.gemini ? "[CONFIGURED]" : undefined,
			openai: config.apiKeys.openai ? "[CONFIGURED]" : undefined,
			anthropic: config.apiKeys.anthropic ? "[CONFIGURED]" : undefined,
		},
		ollamaHost: config.ollamaHost,
	};
}
