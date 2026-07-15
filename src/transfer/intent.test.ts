import { describe, expect, test } from "bun:test";
import {
	appendTransferFilePathInstruction,
	detectTransferIntent,
	resolveTransferIntent,
} from "./intent.js";

describe("transfer intent detection", () => {
	test("detects import file paths from natural-language prompts", () => {
		expect(detectTransferIntent("import ./data/customers.csv")?.filePath).toBe(
			"./data/customers.csv",
		);
		expect(
			detectTransferIntent("import '/tmp/customer export.sql'")?.filePath,
		).toBe("/tmp/customer export.sql");
	});

	test("leaves file path empty when an import prompt only names a format", () => {
		const intent = detectTransferIntent("import this as csv");

		expect(intent?.direction).toBe("import");
		expect(intent?.format).toBe("csv");
		expect(intent?.filePath).toBeUndefined();
	});

	test("prefers an explicit database import over a preceding download", () => {
		const intent = detectTransferIntent(
			"Download chinook.zip with curl and import it into the chinook connection.",
		);

		expect(intent?.direction).toBe("import");
	});

	test("appends explicit import file path HITL instruction", () => {
		expect(
			appendTransferFilePathInstruction("import my data", "./customers.csv"),
		).toContain("Use ./customers.csv as the database import file path.");
	});

	test("resolves missing import parameters with HITL answers", async () => {
		const resolved = await resolveTransferIntent({
			question: "import customers",
			noConfirm: false,
			isInteractive: true,
			promptForFormat: async () => "csv",
			promptForImportFilePath: async () => "./customers.csv",
			promptForExportFilePath: async () => undefined,
			promptForExportResource: async () => undefined,
		});

		expect(resolved.question).toContain(
			"Use csv as the database transfer file format.",
		);
		expect(resolved.question).toContain(
			"Use ./customers.csv as the database import file path.",
		);
	});

	test("resolves missing export parameters with HITL answers", async () => {
		const resolved = await resolveTransferIntent({
			question: "export data",
			noConfirm: false,
			isInteractive: true,
			promptForFormat: async () => "json",
			promptForImportFilePath: async () => undefined,
			promptForExportFilePath: async () => "./exports/data.json",
			promptForExportResource: async () => "public.projects",
		});

		expect(resolved.question).toContain(
			"Use json as the database transfer file format.",
		);
		expect(resolved.question).toContain(
			"Use ./exports/data.json as the database export output file path.",
		);
		expect(resolved.question).toContain(
			"Export this database resource: public.projects.",
		);
	});

	test("does not ask for export resource when it is in the prompt", async () => {
		let resourcePrompted = false;
		const resolved = await resolveTransferIntent({
			question: "export projects to csv",
			noConfirm: false,
			isInteractive: true,
			promptForFormat: async () => "csv",
			promptForImportFilePath: async () => undefined,
			promptForExportFilePath: async () => "./projects.csv",
			promptForExportResource: async () => {
				resourcePrompted = true;
				return "public.projects";
			},
		});

		expect(resourcePrompted).toBe(false);
		expect(resolved.question).toContain(
			"Use ./projects.csv as the database export output file path.",
		);
	});

	test("fails closed for missing export parameters in non-interactive mode", async () => {
		await expect(
			resolveTransferIntent({
				question: "export data",
				noConfirm: true,
				isInteractive: false,
				promptForFormat: async () => "csv",
				promptForImportFilePath: async () => undefined,
				promptForExportFilePath: async () => "./data.csv",
				promptForExportResource: async () => "public.projects",
			}),
		).rejects.toThrow(/file extension or format/i);
	});
});
