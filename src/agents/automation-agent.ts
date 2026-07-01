import type { ThreadOptions } from "@openai/codex-sdk";
import {
	createAutomationReview,
	describeAutomationAction,
	describeAutomationTrigger,
	validateAutomationSpec,
	type AutomationSpecValidationResult,
} from "@/automation/spec.js";
import {
	AUTOMATION_SPEC_OUTPUT_SCHEMA,
	AutomationSpecV1Schema,
	type AutomationMode,
	type AutomationReview,
	type AutomationSpecV1,
} from "@/automation/types.js";
import { AutomationGenerationError } from "@/automation/errors.js";

export const DEFAULT_AUTOMATION_TEST_MODEL = "gemini-3.1-flash";

export interface AutomationIntent {
	readonly query: string;
	readonly actionHint: "test.heartbeat" | "qcp.ask.readonly";
	readonly triggerHint: "manual" | "cron" | "unknown";
	readonly connectionNameHint?: string;
	readonly safetyNotes: readonly string[];
}

export interface AutomationDraftResult {
	readonly intent: AutomationIntent;
	readonly spec: AutomationSpecV1;
	readonly validation: AutomationSpecValidationResult;
	readonly review: AutomationReview;
}

export interface GenerateAutomationSpecInput {
	readonly query: string;
	readonly intent: AutomationIntent;
	readonly mode: AutomationMode;
}

export interface AutomationSpecGenerator {
	generateSpec(input: GenerateAutomationSpecInput): Promise<AutomationSpecV1>;
}

export interface CodexAutomationSpecGeneratorOptions {
	readonly testModel?: string;
	readonly productionModel?: string;
	readonly workingDirectory?: string;
}

export class CodexAutomationSpecGenerator implements AutomationSpecGenerator {
	private readonly testModel: string;
	private readonly productionModel?: string;
	private readonly workingDirectory: string;

	public constructor(options: CodexAutomationSpecGeneratorOptions = {}) {
		this.testModel = options.testModel ?? DEFAULT_AUTOMATION_TEST_MODEL;
		this.productionModel =
			options.productionModel ?? process.env.QCP_AUTOMATION_CODEX_MODEL;
		this.workingDirectory = options.workingDirectory ?? process.cwd();
	}

	public async generateSpec(
		input: GenerateAutomationSpecInput,
	): Promise<AutomationSpecV1> {
		const { Codex } = await import("@openai/codex-sdk");
		const codex = new Codex();
		const threadOptions: ThreadOptions = {
			sandboxMode: "read-only",
			approvalPolicy: "never",
			workingDirectory: this.workingDirectory,
			skipGitRepoCheck: true,
			networkAccessEnabled: false,
			webSearchMode: "disabled",
		};
		const model = this.resolveModel(input.mode);
		if (model) {
			threadOptions.model = model;
		}

		const thread = codex.startThread(threadOptions);
		const turn = await thread.run(buildAutomationGeneratorPrompt(input), {
			outputSchema: AUTOMATION_SPEC_OUTPUT_SCHEMA,
		});
		const parsedJson = parseCodexJsonResponse(turn.finalResponse);
		const spec = AutomationSpecV1Schema.safeParse(parsedJson);

		if (!spec.success) {
			throw new AutomationGenerationError(
				`Codex generated an invalid automation spec: ${spec.error.issues
					.map((issue) => issue.message)
					.join("; ")}`,
			);
		}

		return spec.data;
	}

	private resolveModel(mode: AutomationMode): string | undefined {
		if (mode === "test") return this.testModel;
		return this.productionModel;
	}
}

export interface QcpAutomationAgentOptions {
	readonly generator?: AutomationSpecGenerator;
}

export class QcpAutomationAgent {
	private readonly generator: AutomationSpecGenerator;

	public constructor(options: QcpAutomationAgentOptions = {}) {
		this.generator = options.generator ?? new CodexAutomationSpecGenerator();
	}

	public async createDraft(
		query: string,
		mode: AutomationMode = "production",
	): Promise<AutomationDraftResult> {
		const intent = this.understandIntent(query);
		const spec = await this.generateDraftSpec({ query, intent, mode });
		const validation = this.validateDraftSpec(spec);
		const review = this.createSetupReview(spec, validation.issues);

		return {
			intent,
			spec,
			validation,
			review,
		};
	}

	public understandIntent(query: string): AutomationIntent {
		const normalized = query.trim();
		const lower = normalized.toLowerCase();
		const actionHint = /\b(heartbeat|test workflow|test automation)\b/i.test(
			normalized,
		)
			? "test.heartbeat"
			: "qcp.ask.readonly";
		const triggerHint =
			/\b(cron|schedule|scheduled|every|daily|hourly|weekly)\b/i.test(
				normalized,
			)
				? "cron"
				: /\b(manual|on demand|run when asked)\b/i.test(normalized)
					? "manual"
					: "unknown";
		const connectionNameHint =
			lower.match(/\bconnection\s+([a-z0-9_-]+)/)?.[1] ??
			lower.match(/\bdatabase\s+([a-z0-9_-]+)/)?.[1];

		return {
			query: normalized,
			actionHint,
			triggerHint,
			connectionNameHint,
			safetyNotes: [
				"No generated automation may activate without approval.",
				"Database automations must use secret environment references, not raw credentials.",
				"Database automations must remain read-only.",
			],
		};
	}

	public async generateDraftSpec(
		input: GenerateAutomationSpecInput,
	): Promise<AutomationSpecV1> {
		return this.generator.generateSpec(input);
	}

	public validateDraftSpec(
		spec: AutomationSpecV1,
	): AutomationSpecValidationResult {
		return validateAutomationSpec(spec);
	}

	public createSetupReview(
		spec: AutomationSpecV1,
		validationIssues: readonly string[] = [],
	): AutomationReview {
		return createAutomationReview(spec, validationIssues);
	}
}

function buildAutomationGeneratorPrompt(
	input: GenerateAutomationSpecInput,
): string {
	const connectionHint = input.intent.connectionNameHint ?? "default";

	return [
		"You generate qcp durable automation specs. Return JSON only.",
		"",
		"Allowed spec version: v1.",
		"Allowed triggers: manual, cron with a five-field cron expression.",
		"Allowed actions: test.heartbeat, qcp.ask.readonly.",
		"All specs must be read-only and require human approval before activation.",
		"Never include raw credentials, tokens, URLs, or secrets. Use environment variable names only.",
		"For qcp.ask.readonly, include databaseSecretEnv in requiredEnvVars.",
		"For qcp.ask.readonly, default connectionName to the connection hint if the user did not name one.",
		"For qcp.ask.readonly, default databaseSecretEnv to QCP_AUTOMATION_DATABASE_URL unless a safer named env ref is obvious.",
		"For test or heartbeat requests, use test.heartbeat with a concise message.",
		"",
		`Mode: ${input.mode}`,
		`Action hint: ${input.intent.actionHint}`,
		`Trigger hint: ${input.intent.triggerHint}`,
		`Connection hint: ${connectionHint}`,
		"",
		"User query:",
		input.query,
		"",
		"Before returning JSON, make the idea concrete in the fields: name, description, trigger, action, requiredEnvVars, and safety.",
		`Use action descriptions like: ${describeAutomationAction({
			type: "test.heartbeat",
			message: "qcp automation heartbeat",
		})}`,
		`Use trigger descriptions like: ${describeAutomationTrigger({
			type: "manual",
		})}`,
	].join("\n");
}

function parseCodexJsonResponse(response: string): unknown {
	const trimmed = response.trim();
	const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
	const jsonText = fencedMatch?.[1] ?? trimmed;

	try {
		return JSON.parse(jsonText);
	} catch (cause: unknown) {
		throw new AutomationGenerationError(
			"Codex did not return valid JSON for the automation spec.",
			{ cause },
		);
	}
}
