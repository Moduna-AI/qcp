import chalk from "chalk";
import inquirer from "inquirer";
import ora from "ora";
import {
	AVAILABLE_MODELS,
	DEFAULT_MODELS,
	loadConfig,
	saveConfig,
} from "@/config/index.js";
import { createProvider } from "@/llm/index.js";
import {
	buildAuditResource,
	resolveAuditActor,
	writeAuditEvent,
} from "@/logger/audit.js";
import {
	printBanner,
	printError,
	printInfo,
	printSection,
	printSuccess,
} from "@/output/index.js";
import { providerPackageGroup } from "@/packages/lazy-packages.js";
import { ensurePackageGroups } from "@/packages/runtime.js";
import { trackProviderSelected } from "@/telemetry/index.js";
import type { ProviderName } from "@/types/index.js";

const PROVIDER_INFO: Record<
	ProviderName,
	{ label: string; keyUrl?: string; envVar?: string }
> = {
	gemini: {
		label: "Google Gemini  (default — free tier available)",
		keyUrl: "https://aistudio.google.com/app/apikey",
		envVar: "GEMINI_API_KEY",
	},
	openai: {
		label: "OpenAI         (GPT-4o)",
		keyUrl: "https://platform.openai.com/api-keys",
		envVar: "OPENAI_API_KEY",
	},
	anthropic: {
		label: "Anthropic      (Claude)",
		keyUrl: "https://console.anthropic.com/settings/keys",
		envVar: "ANTHROPIC_API_KEY",
	},
	ollama: {
		label: "Ollama         (local — no API key needed)",
		envVar: undefined,
	},
};

export async function authCommand(): Promise<void> {
	printBanner();
	printSection("Authentication Setup");
	console.log(
		chalk.dim(
			"  Configure your AI provider to start querying your database.\n",
		),
	);

	const config = loadConfig();

	// ── Choose provider ───────────────────────────────────────────────────────────
	const { provider } = await inquirer.prompt<{ provider: ProviderName }>([
		{
			type: "select",
			name: "provider",
			message: "Select a provider:",
			default: config.provider,
			choices: (Object.keys(PROVIDER_INFO) as ProviderName[]).map((p) => ({
				name: PROVIDER_INFO[p].label,
				value: p,
			})),
		},
	]);

	const info = PROVIDER_INFO[provider];

	// ── Ollama path (no key needed) ───────────────────────────────────────────────
	if (provider === "ollama") {
		const { host } = await inquirer.prompt<{ host: string }>([
			{
				type: "input",
				name: "host",
				message: "Ollama server URL:",
				default: config.ollamaHost ?? "http://localhost:11434",
			},
		]);

		const model = DEFAULT_MODELS.ollama;
		saveConfig({ ...config, provider: "ollama", model, ollamaHost: host });
		trackProviderSelected("ollama", model);

		const spinner = ora("Testing Ollama connection...").start();
		const testConfig = {
			...config,
			provider: "ollama" as ProviderName,
			model,
			ollamaHost: host,
		};
		const testProvider = await createProvider(testConfig);
		const ok = await testProvider.testConnectivity();

		if (ok) {
			spinner.succeed(`Connected to Ollama at ${host}`);
			printSuccess("Ollama configured — no API key required");
			await auditAuthEvent(config.installId, "LOGIN_SUCCESS", "success", {
				provider: "ollama",
				model,
			});
		} else {
			spinner.warn("Could not reach Ollama");
			printInfo(`Make sure Ollama is running: ollama serve`);
			printInfo(`Then pull a model: ollama pull ${model}`);
			await auditAuthEvent(config.installId, "LOGIN_FAILED", "failure", {
				provider: "ollama",
				model,
			});
		}

		_printNextSteps();
		return;
	}

	// ── API-key providers ─────────────────────────────────────────────────────────
	if (info.keyUrl) {
		console.log();
		console.log(chalk.dim(`  Get your API key at: ${chalk.cyan(info.keyUrl)}`));
		console.log();
	}

	// Check if key already configured
	const existingKey =
		provider === "gemini"
			? (config.apiKeys.gemini ?? process.env.GEMINI_API_KEY)
			: provider === "openai"
				? (config.apiKeys.openai ?? process.env.OPENAI_API_KEY)
				: provider === "anthropic"
					? (config.apiKeys.anthropic ?? process.env.ANTHROPIC_API_KEY)
					: undefined;

	if (existingKey) {
		const { overwrite } = await inquirer.prompt<{ overwrite: boolean }>([
			{
				type: "confirm",
				name: "overwrite",
				message: `An API key is already configured for ${provider}. Replace it?`,
				default: false,
			},
		]);
		if (!overwrite) {
			printInfo("Keeping existing key.");
			await auditAuthEvent(config.installId, "CONFIG_CHANGE", "cancelled", {
				provider,
				model: config.model,
				reason: "existing_key_kept",
			});
			_printNextSteps();
			return;
		}
	}

	const { apiKey } = await inquirer.prompt<{ apiKey: string }>([
		{
			type: "password",
			name: "apiKey",
			message: `Enter your ${provider} API key:`,
			mask: "●",
			validate: (input: string) => {
				if (!input.trim()) return "API key cannot be empty";
				if (input.trim().length < 10)
					return "That doesn't look like a valid API key";
				return true;
			},
		},
	]);

	// ── Choose model ──────────────────────────────────────────────────────────────
	const { model } = await inquirer.prompt<{ model: string }>([
		{
			type: "select",
			name: "model",
			message: "Select a model:",
			default: DEFAULT_MODELS[provider],
			choices: _modelChoices(provider),
		},
	]);

	// ── Save config ───────────────────────────────────────────────────────────────
	const updatedKeys = { ...config.apiKeys, [provider]: apiKey.trim() };
	saveConfig({ ...config, provider, model, apiKeys: updatedKeys });
	trackProviderSelected(provider, model);

	// ── Test connectivity ─────────────────────────────────────────────────────────
	const spinner = ora(`Testing ${provider} connectivity...`).start();

	const testConfig = { ...config, provider, model, apiKeys: updatedKeys };

	try {
		await ensurePackageGroups({
			commandName: "qcp auth",
			groups: [providerPackageGroup(provider)],
		});
		const testProvider = await createProvider(testConfig);
		const ok = await Promise.race([
			testProvider.testConnectivity(),
			new Promise<boolean>((res) => setTimeout(() => res(false), 10_000)),
		]);

		if (ok) {
			spinner.succeed(`Connected to ${provider} (${model})`);
			printSuccess(`API key saved and verified for ${provider}`);
			await auditAuthEvent(config.installId, "LOGIN_SUCCESS", "success", {
				provider,
				model,
			});
		} else {
			spinner.warn("Could not verify API key");
			printInfo("Key saved. Check it at: qcp doctor");
			await auditAuthEvent(config.installId, "LOGIN_FAILED", "failure", {
				provider,
				model,
			});
		}
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		spinner.fail("Connectivity test failed");
		printError(message);
		printInfo("Your key has been saved. Run qcp doctor to diagnose.");
		await auditAuthEvent(config.installId, "LOGIN_FAILED", "failure", {
			provider,
			model,
			error: message,
		});
	}

	_printNextSteps();
}

// ── Quick key setter (non-interactive) ────────────────────────────────────────

export async function authSetKey(
	provider: string,
	apiKey: string,
): Promise<void> {
	const validProviders: ProviderName[] = ["gemini", "openai", "anthropic"];
	if (!validProviders.includes(provider as ProviderName)) {
		printError(
			`Invalid provider: ${provider}`,
			`Valid: ${validProviders.join(", ")}`,
		);
		process.exit(1);
	}

	const config = loadConfig();
	const updatedKeys = { ...config.apiKeys, [provider]: apiKey };
	saveConfig({ ...config, apiKeys: updatedKeys });
	await auditAuthEvent(config.installId, "CONFIG_CHANGE", "success", {
		provider: provider as ProviderName,
		model: config.model,
	});
	printSuccess(`API key saved for ${provider}`);

	if (config.provider !== provider) {
		printInfo(`Switch to this provider: qcp model set ${provider}`);
	}
}

async function auditAuthEvent(
	installId: string,
	action: "LOGIN_SUCCESS" | "LOGIN_FAILED" | "CONFIG_CHANGE",
	outcome: "success" | "failure" | "cancelled",
	resource: {
		readonly provider: ProviderName;
		readonly model: string;
		readonly reason?: string;
		readonly error?: string;
	},
): Promise<void> {
	await writeAuditEvent({
		scope: "auth",
		action,
		actor: resolveAuditActor(installId),
		resource: buildAuditResource({
			command: "auth",
			installId,
			provider: resource.provider,
			model: resource.model,
		}),
		delta: null,
		outcome,
		metadata: {
			reason: resource.reason ?? null,
			error: resource.error ?? null,
		},
	});
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _modelChoices(provider: ProviderName) {
	const defaults: Record<ProviderName, string[]> = {
		gemini: AVAILABLE_MODELS.gemini,
		openai: AVAILABLE_MODELS.openai,
		anthropic: AVAILABLE_MODELS.anthropic,
		ollama: AVAILABLE_MODELS.ollama,
	};
	return defaults[provider];
}

function _printNextSteps(): void {
	console.log();
	console.log(chalk.bold("  Next steps:"));
	console.log(chalk.dim("  1. ") + chalk.white("qcp connect"));
	console.log(chalk.dim("  2. ") + chalk.white("qcp schema scan"));
	console.log(
		chalk.dim("  3. ") + chalk.white('qcp ask "What were our top customers?"'),
	);
	console.log();
}
