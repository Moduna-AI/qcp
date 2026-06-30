import chalk from "chalk";
import {
	CONFIG_PATH,
	getActiveDatabaseConnection,
	isDatabaseType,
	loadConfig,
	saveConfig,
} from "@/config/index.js";
import { printError, printSection, printSuccess } from "@/output/index.js";
import type { ProviderName } from "@/types/index.js";

const SETTABLE_BOOLEANS = ["safeMode", "showSql", "showMetrics", "telemetry"];
const SETTABLE_STRINGS = [
	"ollamaHost",
	"prismaSchemaPath",
	"prismaDatasourceName",
];

export function configShowCommand(): void {
	const config = loadConfig();

	console.log();
	printSection("Configuration");
	console.log(`  Path:         ${chalk.dim(CONFIG_PATH)}`);
	console.log(`  Install ID:   ${chalk.dim(config.installId)}`);
	console.log(`  Version:      ${config.version}`);
	console.log();
	console.log(`  Provider:     ${chalk.bold(config.provider)}`);
	console.log(`  Model:        ${chalk.bold(config.model)}`);
	const active = getActiveDatabaseConnection(config);
	console.log(
		`  Database:     ${active ? chalk.bold(active.name) : chalk.dim("not configured")}`,
	);
	if (config.databaseConnections.length > 0) {
		console.log(`  Connections:  ${config.databaseConnections.length}`);
		for (const connection of config.databaseConnections) {
			const marker = connection.id === active?.id ? "*" : "-";
			console.log(
				`    ${marker} ${chalk.cyan(connection.name)} ${chalk.dim(connection.databaseType)} ${chalk.dim("[url redacted]")}`,
			);
		}
	}
	if (active?.prismaSchemaPath) {
		console.log(`  Prisma file:  ${chalk.dim(active.prismaSchemaPath)}`);
	}
	if (active?.prismaDatasourceName) {
		console.log(`  Datasource:   ${chalk.dim(active.prismaDatasourceName)}`);
	}
	console.log();
	console.log(`  Safe mode:    ${boolLabel(config.safeMode)}`);
	console.log(`  Show SQL:     ${boolLabel(config.showSql)}`);
	console.log(`  Metrics:      ${boolLabel(config.showMetrics)}`);
	console.log(`  Telemetry:    ${boolLabel(config.telemetry)}`);
	console.log();
	console.log(`  API keys:`);
	console.log(
		`    Gemini:     ${keyLabel(config.apiKeys.gemini, "GEMINI_API_KEY")}`,
	);
	console.log(
		`    OpenAI:     ${keyLabel(config.apiKeys.openai, "OPENAI_API_KEY")}`,
	);
	console.log(
		`    Anthropic:  ${keyLabel(config.apiKeys.anthropic, "ANTHROPIC_API_KEY")}`,
	);
	if (config.ollamaHost) {
		console.log(`  Ollama host:  ${chalk.dim(config.ollamaHost)}`);
	}
}

export function configSetCommand(key: string, value: string): void {
	const config = loadConfig();

	if (SETTABLE_BOOLEANS.includes(key)) {
		const boolValue = parseBool(value);
		if (boolValue === null) {
			printError(`Invalid value for ${key}: must be true/false/on/off/1/0`);
			process.exit(1);
		}
		saveConfig({ ...config, [key]: boolValue });
		printSuccess(`${key} = ${boolValue}`);
		return;
	}

	if (SETTABLE_STRINGS.includes(key)) {
		saveConfig({ ...config, [key]: value });
		printSuccess(`${key} = ${value}`);
		return;
	}

	if (key === "databaseType") {
		if (!isDatabaseType(value)) {
			printError(
				`Invalid database type: ${value}`,
				"Valid types: prisma-postgres, neon, supabase, oracle-postgres, other-postgres",
			);
			process.exit(1);
		}

		saveConfig({ ...config, databaseType: value });
		printSuccess(`${key} = ${value}`);
		return;
	}

	printError(
		`Unknown config key: ${key}`,
		`Settable options: ${[...SETTABLE_BOOLEANS, ...SETTABLE_STRINGS, "databaseType"].join(", ")}`,
	);
	process.exit(1);
}

export function configSetKeyCommand(provider: string, apiKey: string): void {
	const validProviders: ProviderName[] = ["gemini", "openai", "anthropic"];

	if (!validProviders.includes(provider as ProviderName)) {
		printError(
			`Invalid provider: ${provider}`,
			`Valid providers: ${validProviders.join(", ")}`,
		);
		process.exit(1);
	}

	const config = loadConfig();
	const updatedKeys = { ...config.apiKeys, [provider]: apiKey };
	saveConfig({ ...config, apiKeys: updatedKeys });
	printSuccess(`API key saved for ${provider}`);

	// Switch to this provider if not already configured
	if (config.provider !== provider) {
		console.log(
			chalk.dim(
				`  Tip: switch to this provider with: qcp model set ${provider}`,
			),
		);
	}
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function boolLabel(val: boolean): string {
	return val ? chalk.green("enabled") : chalk.dim("disabled");
}

function keyLabel(key: string | undefined, envVar: string): string {
	if (key) return chalk.green("✓ configured");
	if (process.env[envVar]) return chalk.yellow(`✓ via ${envVar}`);
	return chalk.dim("not set");
}

function parseBool(value: string): boolean | null {
	const lower = value.toLowerCase();
	if (["true", "1", "on", "yes"].includes(lower)) return true;
	if (["false", "0", "off", "no"].includes(lower)) return false;
	return null;
}
