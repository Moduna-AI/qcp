import { getApiKey } from "../config/index.js";
import type { LLMProvider, ProviderName, QcpConfig } from "../types/index.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { GeminiProvider } from "./providers/gemini.js";
import { OllamaProvider } from "./providers/ollama.js";
import { OpenAIProvider } from "./providers/openai.js";

export function createProvider(config: QcpConfig): LLMProvider {
	const apiKey = getApiKey(config);

	switch (config.provider) {
		case "gemini": {
			if (!apiKey) {
				throw new Error(
					"Gemini API key not configured.\n" +
						"Set it with: qcp config set-key gemini YOUR_API_KEY\n" +
						"Or set the environment variable: GEMINI_API_KEY=...",
				);
			}
			return new GeminiProvider(apiKey, config.model);
		}

		case "openai": {
			if (!apiKey) {
				throw new Error(
					"OpenAI API key not configured.\n" +
						"Set it with: qcp config set-key openai YOUR_API_KEY\n" +
						"Or set the environment variable: OPENAI_API_KEY=...",
				);
			}
			return new OpenAIProvider(apiKey, config.model);
		}

		case "anthropic": {
			if (!apiKey) {
				throw new Error(
					"Anthropic API key not configured.\n" +
						"Set it with: qcp config set-key anthropic YOUR_API_KEY\n" +
						"Or set the environment variable: ANTHROPIC_API_KEY=...",
				);
			}
			return new AnthropicProvider(apiKey, config.model);
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

export { AnthropicProvider, GeminiProvider, OllamaProvider, OpenAIProvider };
