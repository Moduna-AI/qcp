import { afterEach, describe, expect, test } from "bun:test";
import { printResults, printSql, printSummary } from "./index.js";

const originalLog = console.log;

describe("terminal output privacy scrubbing", () => {
	afterEach(() => {
		console.log = originalLog;
	});

	test("redacts sensitive literals in displayed SQL", () => {
		const output = captureLogs(() => {
			printSql("SELECT 'ada@example.com' as email, '123-45-6789' as ssn");
		});

		expect(output).not.toContain("ada@example.com");
		expect(output).not.toContain("123-45-6789");
		expect(output).toContain("[REDACTED_EMAIL]");
		expect(output).toContain("[REDACTED_SSN]");
	});

	test("redacts sensitive query result values", () => {
		const output = captureLogs(() => {
			printResults({
				rows: [{ email: "ada@example.com", ssn: "123-45-6789" }],
				rowCount: 1,
				fields: ["email", "ssn"],
				executionTimeMs: 1,
			});
		});

		expect(output).not.toContain("ada@example.com");
		expect(output).not.toContain("123-45-6789");
		expect(output).toContain("[REDACTED_EMAIL]");
		expect(output).toContain("[REDACTED_SSN]");
	});

	test("redacts sensitive summary text", () => {
		const output = captureLogs(() => {
			printSummary("Found ada@example.com with SSN 123-45-6789.");
		});

		expect(output).not.toContain("ada@example.com");
		expect(output).not.toContain("123-45-6789");
		expect(output).toContain("[REDACTED_EMAIL]");
		expect(output).toContain("[REDACTED_SSN]");
	});
});

function captureLogs(fn: () => void): string {
	const lines: string[] = [];
	console.log = (...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	};
	fn();
	return lines.join("\n");
}
