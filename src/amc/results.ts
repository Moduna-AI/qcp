import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { QueryResult } from "@/types/index.js";

export interface AmcDownloadedFile {
	readonly url: string;
	readonly body: string;
	readonly kind: "result" | "metadata";
}

export interface AmcParsedResults {
	readonly queryResult: QueryResult;
	readonly files: readonly AmcDownloadedFile[];
}

export function parseAmazonMarketingCloudResults(
	files: readonly AmcDownloadedFile[],
	executionTimeMs: number,
	limit: number,
): QueryResult {
	const rows = files
		.filter((file) => file.kind === "result")
		.flatMap((file) =>
			parseResultRows(file.body, inferFileExtension(file.url)),
		);
	if (rows.length === 0) {
		return { rows: [], rowCount: 0, fields: [], executionTimeMs };
	}

	const fieldSet = new Set<string>();
	for (const row of rows) {
		for (const field of Object.keys(row)) {
			fieldSet.add(field);
		}
	}
	return {
		rows: rows.slice(0, limit),
		rowCount: rows.length,
		fields: [...fieldSet],
		executionTimeMs,
	};
}

export async function exportAmazonMarketingCloudFiles(
	files: readonly AmcDownloadedFile[],
	exportPath: string | undefined,
): Promise<string[]> {
	if (!exportPath || files.length === 0) return [];

	const writeAsSingleFile =
		files.length === 1 &&
		extname(exportPath).length > 0 &&
		(!existsSync(exportPath) || !statSync(exportPath).isDirectory());
	if (writeAsSingleFile) {
		await mkdir(dirname(exportPath), { recursive: true });
		await writeFile(exportPath, files[0].body, "utf-8");
		return [exportPath];
	}

	await mkdir(exportPath, { recursive: true });
	const written: string[] = [];
	for (let index = 0; index < files.length; index += 1) {
		const file = files[index];
		const extension = inferFileExtension(file.url) || "txt";
		const fileName = `${String(index + 1).padStart(2, "0")}-${file.kind}.${extension}`;
		const target = join(exportPath, fileName);
		await writeFile(target, file.body, "utf-8");
		written.push(target);
	}
	return written;
}

export function parseResultRows(
	body: string,
	extension: string,
): Record<string, unknown>[] {
	const trimmed = body.trim();
	if (!trimmed) return [];

	if (
		extension === "json" ||
		trimmed.startsWith("[") ||
		trimmed.startsWith("{")
	) {
		return parseJsonRows(trimmed);
	}

	return parseCsvRows(trimmed);
}

export function parseCsvRows(body: string): Record<string, unknown>[] {
	const records = parseCsvRecords(body);
	if (records.length === 0) return [];
	const [headers, ...rows] = records;
	return rows.map((row) =>
		Object.fromEntries(
			headers.map((header, index) => [header, row[index] ?? ""]),
		),
	);
}

function parseJsonRows(body: string): Record<string, unknown>[] {
	const parsed = JSON.parse(body) as unknown;
	if (Array.isArray(parsed)) {
		return parsed.flatMap((item) =>
			item && typeof item === "object" ? [item as Record<string, unknown>] : [],
		);
	}
	if (parsed && typeof parsed === "object") {
		const record = parsed as Record<string, unknown>;
		for (const key of ["rows", "results", "data"]) {
			const candidate = record[key];
			if (Array.isArray(candidate)) {
				return candidate.flatMap((item) =>
					item && typeof item === "object"
						? [item as Record<string, unknown>]
						: [],
				);
			}
		}
		return [record];
	}
	return [];
}

function parseCsvRecords(body: string): string[][] {
	const records: string[][] = [];
	let record: string[] = [];
	let field = "";
	let inQuotes = false;

	for (let index = 0; index < body.length; index += 1) {
		const char = body[index];
		const next = body[index + 1];

		if (char === '"' && inQuotes && next === '"') {
			field += '"';
			index += 1;
			continue;
		}

		if (char === '"') {
			inQuotes = !inQuotes;
			continue;
		}

		if (char === "," && !inQuotes) {
			record.push(field);
			field = "";
			continue;
		}

		if ((char === "\n" || char === "\r") && !inQuotes) {
			if (char === "\r" && next === "\n") index += 1;
			record.push(field);
			records.push(record);
			record = [];
			field = "";
			continue;
		}

		field += char;
	}

	record.push(field);
	records.push(record);
	return records.filter((row) =>
		row.some((fieldValue) => fieldValue.length > 0),
	);
}

function inferFileExtension(url: string): string {
	try {
		const parsed = new URL(url);
		return extname(basename(parsed.pathname)).replace(/^\./, "").toLowerCase();
	} catch {
		return extname(url).replace(/^\./, "").toLowerCase();
	}
}
