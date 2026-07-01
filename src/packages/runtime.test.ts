import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePackageGroups } from "./runtime.js";

describe("runtime package checks", () => {
	test("non-interactive commands fail with install instructions", async () => {
		const targetDir = mkdtempSync(join(tmpdir(), "qcp-runtime-test-"));
		await expect(
			ensurePackageGroups({
				commandName: "qcp ask",
				groups: ["provider-gemini"],
				interactive: false,
				targetDir,
			}),
		).rejects.toThrow("qcp packages install provider-gemini --yes");
	});

	test("ollama provider never requires npm installation", async () => {
		await expect(
			ensurePackageGroups({
				commandName: "qcp ask",
				groups: ["provider-ollama"],
				interactive: false,
			}),
		).resolves.toBeUndefined();
	});
});
