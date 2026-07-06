import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	exportAmazonMarketingCloudFiles,
	parseAmazonMarketingCloudResults,
	parseCsvRows,
	parseResultRows,
} from "./results.js";

describe("Amazon Marketing Cloud results", () => {
	test("parses quoted CSV rows", () => {
		expect(parseCsvRows('campaign_id,users\n"camp,1",42\ncamp2,"7"')).toEqual([
			{ campaign_id: "camp,1", users: "42" },
			{ campaign_id: "camp2", users: "7" },
		]);
	});

	test("parses JSON arrays and caps stdout rows", () => {
		const result = parseAmazonMarketingCloudResults(
			[
				{
					url: "https://example.test/result.json",
					body: JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }]),
					kind: "result",
				},
			],
			123,
			2,
		);

		expect(result.rowCount).toBe(3);
		expect(result.rows).toEqual([{ id: 1 }, { id: 2 }]);
		expect(result.fields).toEqual(["id"]);
	});

	test("writes raw result files to an export directory", async () => {
		const dir = await mkdtemp(join(tmpdir(), "qcp-amc-results-"));
		const files = await exportAmazonMarketingCloudFiles(
			[
				{
					url: "https://example.test/result.csv",
					body: "id\n1",
					kind: "result",
				},
				{
					url: "https://example.test/metadata.json",
					body: "{}",
					kind: "metadata",
				},
			],
			dir,
		);

		expect(files.length).toBe(2);
		expect(await readFile(files[0], "utf-8")).toBe("id\n1");
		expect(await readFile(files[1], "utf-8")).toBe("{}");
	});

	test("parses object-wrapped JSON rows", () => {
		expect(parseResultRows('{"rows":[{"id":"a"}]}', "json")).toEqual([
			{ id: "a" },
		]);
	});
});
