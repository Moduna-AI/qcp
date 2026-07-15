import chalk from "chalk";
import inquirer from "inquirer";
import {
	AVAILABLE_MODELS,
	DEFAULT_MODELS,
	loadConfig,
	saveConfig,
} from "@/config/index.js";
import {
	printError,
	printInfo,
	printSection,
	printSuccess,
} from "@/output/index.js";
import { trackProviderSelected } from "@/telemetry/index.js";
import type { ProviderName } from "@/types/index.js";

const PROVIDERS: ProviderName[] = ["gemini", "openai", "anthropic", "ollama"];

const PROVIDER_LABELS: Record<ProviderName, string> = {
	gemini: "Google Gemini   (default)",
	openai: "OpenAI",
	anthropic: "Anthropic",
	ollama: "Ollama          (local / private)",
};

export function modelListCommand(): void {
	const config = loadConfig();

	console.log();
	for (const provider of PROVIDERS) {
		const isCurrent = provider === config.provider;
		const providerLabel = isCurrent
			? chalk.bold.cyan(`▸ ${provider}`)
			: chalk.dim(`  ${provider}`);

		console.log(providerLabel + chalk.dim(` — ${PROVIDER_LABELS[provider]}`));

		for (const model of AVAILABLE_MODELS[provider]) {
			const isCurrentModel = isCurrent && model === config.model;
			const modelLabel = isCurrentModel
				? chalk.green(`    ✓ ${model}`)
				: chalk.dim(`      ${model}`);
			console.log(modelLabel);
		}
		console.log();
	}
}

export function modelCurrentCommand(): void {
	const config = loadConfig();
	console.log();
	printSection("Current Model");
	console.log(`  Provider: ${chalk.bold(config.provider)}`);
	console.log(`  Model:    ${chalk.bold(config.model)}`);
}

export function modelSetCommand(modelOrProvider: string): void {
	const config = loadConfig();

	// Check if it's a provider name
	if (PROVIDERS.includes(modelOrProvider as ProviderName)) {
		const newProvider = modelOrProvider as ProviderName;
		const defaultModel = DEFAULT_MODELS[newProvider];
		saveConfig({ ...config, provider: newProvider, model: defaultModel });
		trackProviderSelected(newProvider, defaultModel);
		printSuccess(`Provider set to ${newProvider} (${defaultModel})`);
		return;
	}

	// Find which provider this model belongs to
	let foundProvider: ProviderName | null = null;
	for (const provider of PROVIDERS) {
		if (AVAILABLE_MODELS[provider].includes(modelOrProvider)) {
			foundProvider = provider;
			break;
		}
	}

	if (foundProvider) {
		saveConfig({ ...config, provider: foundProvider, model: modelOrProvider });
		trackProviderSelected(foundProvider, modelOrProvider);
		printSuccess(`Model set to ${foundProvider} / ${modelOrProvider}`);
		return;
	}

	// Allow setting arbitrary model names (for Ollama local models)
	if (config.provider === "ollama") {
		saveConfig({ ...config, model: modelOrProvider });
		printSuccess(`Ollama model set to ${modelOrProvider}`);
		return;
	}

	printError(
		`Unknown model: ${modelOrProvider}`,
		`Run 'qcp model list' to see available models.\n` +
			`For custom Ollama models, first switch to Ollama: qcp model set ollama`,
	);
	process.exit(1);
}

export async function modelInteractiveCommand(): Promise<void> {
	const config = loadConfig();

	const { provider } = await inquirer.prompt<{ provider: ProviderName }>([
		{
			type: "select",
			name: "provider",
			message: "Select a provider:",
			default: config.provider,
			choices: PROVIDERS.map((p) => ({
				name: `${p} — ${PROVIDER_LABELS[p]}`,
				value: p,
			})),
		},
	]);

	const { model } = await inquirer.prompt<{ model: string }>([
		{
			type: "select",
			name: "model",
			message: "Select a model:",
			default:
				provider === config.provider ? config.model : DEFAULT_MODELS[provider],
			choices: AVAILABLE_MODELS[provider],
		},
	]);

	saveConfig({ ...config, provider, model });
	trackProviderSelected(provider, model);
	printSuccess(`Model set to ${provider} / ${model}`);

	if (provider !== "ollama") {
		const keyVar = {
			gemini: "GEMINI_API_KEY",
			openai: "OPENAI_API_KEY",
			anthropic: "ANTHROPIC_API_KEY",
			ollama: "",
		}[provider];

		const hasKey =
			provider === "gemini"
				? !!(config.apiKeys.gemini ?? process.env.GEMINI_API_KEY)
				: provider === "openai"
					? !!(config.apiKeys.openai ?? process.env.OPENAI_API_KEY)
					: !!(config.apiKeys.anthropic ?? process.env.ANTHROPIC_API_KEY);

		if (!hasKey) {
			console.log();
			printInfo(
				`Don't forget to set your API key:\n` +
					`  qcp config set-key ${provider} YOUR_${keyVar}`,
			);
		}
	}
}
