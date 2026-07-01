import { getApiKey } from "@/config/index.js";
import type { QcpConfig } from "@/types/index.js";
import type { DatabaseAgentConfig } from "./database-agent.js";

export function createMastraModelConfig(
	config: QcpConfig,
): DatabaseAgentConfig["model"] {
	const apiKey = getApiKey(config);
	applyProviderEnv(config, apiKey);

	switch (config.provider) {
		case "gemini":
			return `google/${config.model}` as DatabaseAgentConfig["model"];
		case "openai":
			return `openai/${config.model}` as DatabaseAgentConfig["model"];
		case "anthropic":
			return `anthropic/${config.model}` as DatabaseAgentConfig["model"];
		case "ollama":
			if (config.ollamaHost) {
				process.env.OLLAMA_BASE_URL = config.ollamaHost;
			}
			return `ollama/${config.model}` as DatabaseAgentConfig["model"];
		default: {
			const _exhaustive: never = config.provider;
			return _exhaustive;
		}
	}
}

function applyProviderEnv(config: QcpConfig, apiKey: string | undefined): void {
	if (!apiKey || config.provider === "ollama") return;

	if (config.provider === "gemini") {
		process.env.GOOGLE_GENERATIVE_AI_API_KEY = apiKey;
		process.env.GOOGLE_API_KEY = apiKey;
		return;
	}

	if (config.provider === "openai") {
		process.env.OPENAI_API_KEY = apiKey;
		return;
	}

	process.env.ANTHROPIC_API_KEY = apiKey;
}
