import type { PackageGroup } from "@/packages/lazy-packages.js";
import {
	getTransferFormatAdapter,
	listSupportedTransferFormats,
} from "./format-adapters.js";
import type {
	DatabaseTransferDirection,
	DatabaseTransferFormat,
} from "./types.js";

const FORMAT_ALIASES: Record<string, DatabaseTransferFormat> = {
	csv: "csv",
	tsv: "tsv",
	tab: "tsv",
	json: "json",
	jsonl: "jsonl",
	ndjson: "jsonl",
	parquet: "parquet",
	db: "sqlite",
	sqlite: "sqlite",
	sqlite3: "sqlite",
	pd: "pandas",
	pkl: "pandas",
	pickle: "pandas",
	sql: "postgres-dump",
	dump: "postgres-dump",
	tar: "postgres-dump",
};

export interface TransferIntent {
	readonly direction: DatabaseTransferDirection;
	readonly format?: DatabaseTransferFormat;
	readonly filePath?: string;
	readonly resource?: string;
}

export function detectTransferIntent(question: string): TransferIntent | null {
	const normalized = question.toLowerCase();
	const direction = detectDirection(normalized);
	if (!direction) return null;

	return {
		direction,
		format: detectFormat(normalized),
		filePath: detectFilePath(question),
		resource: detectResource(question, direction),
	};
}

export interface ResolvedTransferIntent {
	readonly question?: string;
	readonly packageGroup?: PackageGroup;
}

export interface ResolveTransferIntentOptions {
	readonly question: string;
	readonly noConfirm: boolean;
	readonly isInteractive?: boolean;
	readonly promptForFormat: (
		direction: DatabaseTransferDirection,
	) => Promise<DatabaseTransferFormat | undefined>;
	readonly promptForImportFilePath: () => Promise<string | undefined>;
	readonly promptForExportFilePath: (
		format: DatabaseTransferFormat,
	) => Promise<string | undefined>;
	readonly promptForExportResource: () => Promise<string | undefined>;
}

export async function resolveTransferIntent(
	options: ResolveTransferIntentOptions,
): Promise<ResolvedTransferIntent> {
	const intent = detectTransferIntent(options.question);
	if (!intent) return {};

	const canPrompt = !options.noConfirm && (options.isInteractive ?? true);
	const format =
		intent.format ??
		(canPrompt ? await options.promptForFormat(intent.direction) : undefined);
	if (!format) {
		throw new Error(
			"Import/export requests must include a supported file extension or format.",
		);
	}

	const importFilePath =
		intent.direction === "import" && !intent.filePath && canPrompt
			? await options.promptForImportFilePath()
			: undefined;
	if (intent.direction === "import" && !intent.filePath && !importFilePath) {
		throw new Error(
			"Import requests must include a file path, or run qcp interactively so qcp can ask for one.",
		);
	}

	const exportFilePath =
		intent.direction === "export" && !intent.filePath && canPrompt
			? await options.promptForExportFilePath(format)
			: undefined;
	if (intent.direction === "export" && !intent.filePath && !exportFilePath) {
		throw new Error(
			"Export requests must include an output file path, or run qcp interactively so qcp can ask for one.",
		);
	}

	const exportResource =
		intent.direction === "export" && !intent.resource && canPrompt
			? await options.promptForExportResource()
			: undefined;
	if (intent.direction === "export" && !intent.resource && !exportResource) {
		throw new Error(
			"Export requests must name a table, schema, database, or query to export, or run qcp interactively so qcp can ask for one.",
		);
	}

	let nextQuestion = options.question;
	if (!intent.format) {
		nextQuestion = appendTransferFormatInstruction(nextQuestion, format);
	}
	if (importFilePath) {
		nextQuestion = appendTransferFilePathInstruction(
			nextQuestion,
			importFilePath,
		);
	}
	if (exportFilePath) {
		nextQuestion = appendTransferOutputPathInstruction(
			nextQuestion,
			exportFilePath,
		);
	}
	if (exportResource) {
		nextQuestion = appendTransferResourceInstruction(
			nextQuestion,
			exportResource,
		);
	}

	return {
		question: nextQuestion === options.question ? undefined : nextQuestion,
		packageGroup: transferFormatPackageGroup(format, intent.direction),
	};
}

export function appendTransferFormatInstruction(
	question: string,
	format: DatabaseTransferFormat,
): string {
	return `${question}\n\nUse ${format} as the database transfer file format.`;
}

export function appendTransferFilePathInstruction(
	question: string,
	filePath: string,
): string {
	return `${question}\n\nUse ${filePath} as the database import file path.`;
}

export function appendTransferOutputPathInstruction(
	question: string,
	filePath: string,
): string {
	return `${question}\n\nUse ${filePath} as the database export output file path.`;
}

export function appendTransferResourceInstruction(
	question: string,
	resource: string,
): string {
	return `${question}\n\nExport this database resource: ${resource}.`;
}

export function supportedTransferFormatChoices(
	direction: DatabaseTransferDirection,
): readonly DatabaseTransferFormat[] {
	return listSupportedTransferFormats(direction);
}

export function transferFormatPackageGroup(
	format: DatabaseTransferFormat | undefined,
	direction: DatabaseTransferDirection,
): PackageGroup | undefined {
	if (!format) return undefined;
	const adapter = getTransferFormatAdapter(format);
	const supported =
		direction === "import" ? adapter.importSupported : adapter.exportSupported;
	return supported ? adapter.packageGroup : undefined;
}

function detectDirection(question: string): DatabaseTransferDirection | null {
	if (/\bimport\b/.test(question)) return "import";
	if (/\bexport\b/.test(question)) return "export";
	if (/\b(dump|download|save)\b/.test(question)) return "export";
	if (/\b(load|upload|ingest)\b/.test(question)) return "import";
	return null;
}

function detectFormat(question: string): DatabaseTransferFormat | undefined {
	for (const [alias, format] of Object.entries(FORMAT_ALIASES)) {
		if (new RegExp(`\\.${alias}\\b|\\b${alias}\\b`, "i").test(question)) {
			return format;
		}
	}
	return undefined;
}

function detectFilePath(question: string): string | undefined {
	const quoted =
		/["']([^"']+\.(csv|tsv|tab|json|jsonl|ndjson|parquet|db|sqlite|sqlite3|pd|pkl|pickle|sql|dump|tar))["']/i.exec(
			question,
		);
	if (quoted?.[1]) return quoted[1];

	const token =
		/(?:^|\s)(\.{0,2}\/?[^\s]+\.(csv|tsv|tab|json|jsonl|ndjson|parquet|db|sqlite|sqlite3|pd|pkl|pickle|sql|dump|tar))(?=\s|$)/i.exec(
			question,
		);
	return token?.[1];
}

function detectResource(
	question: string,
	direction: DatabaseTransferDirection,
): string | undefined {
	if (direction !== "export") return undefined;
	if (/\b(database|schema|table|query|sql|result|results)\b/i.test(question)) {
		return "mentioned in prompt";
	}

	const fromMatch = /\bfrom\s+([a-zA-Z_][a-zA-Z0-9_$.]*)\b/i.exec(question);
	if (fromMatch?.[1]) return fromMatch[1];

	const ofMatch = /\bof\s+([a-zA-Z_][a-zA-Z0-9_$.]*)\b/i.exec(question);
	if (ofMatch?.[1]) return ofMatch[1];

	const exportMatch =
		/\b(?:export|dump|download|save)\s+([a-zA-Z_][a-zA-Z0-9_$.]*)\b/i.exec(
			question,
		);
	const resource = exportMatch?.[1];
	if (
		!resource ||
		/^(data|database|db|it|this|that|everything|all)$/i.test(resource)
	) {
		return undefined;
	}
	return resource;
}
