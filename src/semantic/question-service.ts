import inquirer from "inquirer";
import { z } from "zod";
import type { SemanticStore } from "./store.js";
import type {
	SemanticAnnotation,
	SemanticAnnotationSource,
	SemanticObject,
} from "./types.js";

export type SemanticQuestionStatus =
	| "accepted"
	| "declined"
	| "cancelled"
	| "skipped";

export interface SemanticAnnotationDraft {
	readonly description: string;
	readonly businessName?: string;
	readonly synonyms: readonly string[];
	readonly notes?: string;
}

export type SemanticQuestionResponse =
	| {
			readonly status: "accepted";
			readonly draft: SemanticAnnotationDraft;
			readonly source: SemanticAnnotationSource;
	  }
	| {
			readonly status: Exclude<SemanticQuestionStatus, "accepted">;
			readonly reason?: string;
	  };

export interface HumanSemanticQuestionServiceOptions {
	readonly store: SemanticStore;
	readonly cliAdapter?: SemanticQuestionAdapter;
	readonly mcpAdapter?: SemanticQuestionAdapter;
}

export interface SemanticQuestionAdapter {
	requestAnnotation(
		object: SemanticObject,
		context?: unknown,
	): Promise<SemanticQuestionResponse>;
}

export interface EnrichmentRunResult {
	readonly asked: number;
	readonly accepted: number;
	readonly declined: number;
	readonly cancelled: number;
	readonly skipped: number;
	readonly annotations: readonly SemanticAnnotation[];
}

const annotationDraftSchema = z.object({
	description: z.string().trim().min(1),
	businessName: z.string().trim().optional(),
	synonyms: z.string().trim().optional(),
	notes: z.string().trim().optional(),
});

export class HumanSemanticQuestionService {
	private readonly store: SemanticStore;
	private readonly cliAdapter: SemanticQuestionAdapter | undefined;
	private readonly mcpAdapter: SemanticQuestionAdapter | undefined;

	public constructor(options: HumanSemanticQuestionServiceOptions) {
		this.store = options.store;
		this.cliAdapter = options.cliAdapter;
		this.mcpAdapter = options.mcpAdapter;
	}

	public async enrichObjects(
		objects: readonly SemanticObject[],
		options: {
			readonly maxQuestions?: number;
			readonly context?: unknown;
		} = {},
	): Promise<EnrichmentRunResult> {
		const limit = Math.max(0, options.maxQuestions ?? objects.length);
		const annotations: SemanticAnnotation[] = [];
		let asked = 0;
		let accepted = 0;
		let declined = 0;
		let cancelled = 0;
		let skipped = 0;

		for (const object of objects.slice(0, limit)) {
			const adapter = this.resolveAdapter(options.context);
			if (!adapter) {
				skipped += 1;
				continue;
			}

			asked += 1;
			const response = await adapter.requestAnnotation(object, options.context);
			if (response.status === "accepted") {
				const annotation = await this.store.addAnnotation({
					objectId: object.id,
					description: response.draft.description,
					businessName: response.draft.businessName,
					synonyms: response.draft.synonyms,
					notes: response.draft.notes,
					source: response.source,
				});
				annotations.push(annotation);
				accepted += 1;
			} else if (response.status === "declined") {
				declined += 1;
			} else if (response.status === "cancelled") {
				cancelled += 1;
			} else {
				skipped += 1;
			}
		}

		return {
			asked,
			accepted,
			declined,
			cancelled,
			skipped,
			annotations,
		};
	}

	private resolveAdapter(
		context?: unknown,
	): SemanticQuestionAdapter | undefined {
		if (hasMcpElicitation(context) && this.mcpAdapter) return this.mcpAdapter;
		return this.cliAdapter;
	}
}

export class CliSemanticQuestionAdapter implements SemanticQuestionAdapter {
	private readonly interactive: boolean;

	public constructor(options: { readonly interactive?: boolean } = {}) {
		this.interactive = options.interactive ?? isInteractiveTerminal();
	}

	public async requestAnnotation(
		object: SemanticObject,
	): Promise<SemanticQuestionResponse> {
		if (!this.interactive) {
			return {
				status: "skipped",
				reason: "Semantic enrichment prompts are disabled.",
			};
		}

		const label = formatObjectLabel(object);
		const { shouldAnnotate } = await inquirer.prompt<{
			shouldAnnotate: boolean;
		}>([
			{
				type: "confirm",
				name: "shouldAnnotate",
				message: `Add semantic meaning for ${label}?`,
				default: true,
			},
		]);

		if (!shouldAnnotate) return { status: "declined" };

		const answers = await inquirer.prompt<{
			description: string;
			businessName?: string;
			synonyms?: string;
			notes?: string;
		}>([
			{
				type: "input",
				name: "description",
				message: `Plain-English meaning for ${label}`,
				validate: (value: string) =>
					value.trim().length > 0 ? true : "Description is required.",
			},
			{
				type: "input",
				name: "businessName",
				message: "Business name or label",
			},
			{
				type: "input",
				name: "synonyms",
				message: "Synonyms, comma-separated",
			},
			{
				type: "input",
				name: "notes",
				message: "Notes",
			},
		]);

		const parsed = parseAnnotationDraft(answers);
		if (!parsed) return { status: "cancelled" };

		return {
			status: "accepted",
			draft: parsed,
			source: "cli",
		};
	}
}

export class McpSemanticQuestionAdapter implements SemanticQuestionAdapter {
	public async requestAnnotation(
		object: SemanticObject,
		context?: unknown,
	): Promise<SemanticQuestionResponse> {
		const elicitation = getMcpElicitation(context);
		if (!elicitation) {
			return {
				status: "skipped",
				reason: "MCP elicitation is not available.",
			};
		}

		const result = await elicitation.sendRequest({
			message: `Add semantic meaning for ${formatObjectLabel(object)}`,
			requestedSchema: {
				type: "object",
				properties: {
					description: {
						type: "string",
						title: "Description",
						description: "Plain-English meaning for this table or column.",
					},
					businessName: {
						type: "string",
						title: "Business name",
						description: "Optional business-facing label.",
					},
					synonyms: {
						type: "string",
						title: "Synonyms",
						description: "Optional comma-separated aliases.",
					},
					notes: {
						type: "string",
						title: "Notes",
						description: "Optional relationship or caveat notes.",
					},
				},
				required: ["description"],
			},
		});

		if (result.action === "decline") return { status: "declined" };
		if (result.action === "cancel") return { status: "cancelled" };
		if (result.action !== "accept") {
			return {
				status: "skipped",
				reason: "Unsupported MCP elicitation action.",
			};
		}

		const parsed = parseAnnotationDraft(result.content);
		if (!parsed) return { status: "cancelled" };

		return {
			status: "accepted",
			draft: parsed,
			source: "mcp",
		};
	}
}

export function formatObjectLabel(object: SemanticObject): string {
	const table =
		object.schemaName === "public"
			? object.tableName
			: `${object.schemaName}.${object.tableName}`;
	return object.columnName
		? `${object.objectType} ${table}.${object.columnName}`
		: `${object.objectType} ${table}`;
}

function parseAnnotationDraft(value: unknown): SemanticAnnotationDraft | null {
	const result = annotationDraftSchema.safeParse(value);
	if (!result.success) return null;

	return {
		description: result.data.description.trim(),
		businessName: normalizeOptionalString(result.data.businessName),
		synonyms: splitSynonyms(result.data.synonyms),
		notes: normalizeOptionalString(result.data.notes),
	};
}

function splitSynonyms(value: string | undefined): readonly string[] {
	if (!value) return [];
	return [
		...new Set(
			value
				.split(",")
				.map((item) => item.trim())
				.filter((item) => item.length > 0),
		),
	].sort((a, b) => a.localeCompare(b));
}

function normalizeOptionalString(
	value: string | undefined,
): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

interface McpElicitationResult {
	readonly action: string;
	readonly content?: unknown;
}

interface McpElicitation {
	sendRequest(request: {
		readonly message: string;
		readonly requestedSchema: Record<string, unknown>;
	}): Promise<McpElicitationResult>;
}

function hasMcpElicitation(context: unknown): boolean {
	return getMcpElicitation(context) !== null;
}

function getMcpElicitation(context: unknown): McpElicitation | null {
	if (!isRecord(context)) return null;
	const mcp = context.mcp;
	if (!isRecord(mcp)) return null;
	const elicitation = mcp.elicitation;
	if (!isRecord(elicitation)) return null;
	const sendRequest = elicitation.sendRequest;
	if (typeof sendRequest !== "function") return null;
	const send = sendRequest as (request: {
		readonly message: string;
		readonly requestedSchema: Record<string, unknown>;
	}) => Promise<unknown>;

	return {
		sendRequest: async (request) => {
			const result = await send(request);
			return isMcpElicitationResult(result) ? result : { action: "cancel" };
		},
	};
}

function isMcpElicitationResult(value: unknown): value is McpElicitationResult {
	if (!isRecord(value)) return false;
	return typeof value.action === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInteractiveTerminal(): boolean {
	return process.stdin.isTTY === true && process.env.CI !== "1";
}
