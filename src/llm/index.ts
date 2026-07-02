import { getApiKey } from "@/config/index.js";
import {
	providerPackageGroup,
	requirePackageGroup,
} from "@/packages/lazy-packages.js";
import type { LLMProvider, ProviderName, QcpConfig } from "@/types/index.js";
import { OllamaProvider } from "./providers/ollama.js";

export async function createProvider(config: QcpConfig): Promise<LLMProvider> {
	const apiKey = getApiKey(config);
	requirePackageGroup(providerPackageGroup(config.provider));

	switch (config.provider) {
		case "gemini": {
			if (!apiKey) {
				throw new Error(
					"Gemini API key not configured.\n" +
						"Set it with: qcp config set-key gemini YOUR_API_KEY\n" +
						"Or set the environment variable: GEMINI_API_KEY=...",
				);
			}
			const { GeminiProvider } = await import("./providers/gemini.js");
			return await GeminiProvider.create(apiKey, config.model);
		}

		case "openai": {
			if (!apiKey) {
				throw new Error(
					"OpenAI API key not configured.\n" +
						"Set it with: qcp config set-key openai YOUR_API_KEY\n" +
						"Or set the environment variable: OPENAI_API_KEY=...",
				);
			}
			const { OpenAIProvider } = await import("./providers/openai.js");
			return await OpenAIProvider.create(apiKey, config.model);
		}

		case "anthropic": {
			if (!apiKey) {
				throw new Error(
					"Anthropic API key not configured.\n" +
						"Set it with: qcp config set-key anthropic YOUR_API_KEY\n" +
						"Or set the environment variable: ANTHROPIC_API_KEY=...",
				);
			}
			const { AnthropicProvider } = await import("./providers/anthropic.js");
			return await AnthropicProvider.create(apiKey, config.model);
		}

		case "ollama": {
			const host =
				config.ollamaHost ??
				process.env.OLLAMA_HOST ??
				"http://localhost:11434";
			return new OllamaProvider(config.model, host);
		}

		default: {
			const _exhaustive: never = config.provider;
			throw new Error(`Unknown provider: ${_exhaustive}`);
		}
	}
}

export function getProviderLabel(
	provider: ProviderName,
	model: string,
): string {
	const labels: Record<ProviderName, string> = {
		gemini: "Google Gemini",
		openai: "OpenAI",
		anthropic: "Anthropic",
		ollama: "Ollama (local)",
	};
	return `${labels[provider]} / ${model}`;
}

export { OllamaProvider };
