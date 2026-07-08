import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	auditProviderRuntimePackages,
	ensurePackageGroups,
	installMissingPackageGroups,
} from "./runtime.js";

function writeInstalledPackage(store: string, packageName: string): void {
	const packageDir = join(store, "node_modules", ...packageName.split("/"));
	mkdirSync(packageDir, { recursive: true });
	writeFileSync(
		join(store, "package.json"),
		JSON.stringify({ name: "qcp-test-store", type: "module" }),
	);
	writeFileSync(
		join(packageDir, "package.json"),
		JSON.stringify({ name: packageName, version: "1.0.0", main: "index.js" }),
	);
	writeFileSync(join(packageDir, "index.js"), "export default {};\n");
}

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

	test("bundled agent runtime never prompts for installation", async () => {
		await expect(
			ensurePackageGroups({
				commandName: "qcp chat",
				groups: ["agent"],
				interactive: false,
			}),
		).resolves.toBeUndefined();
	});

	test("installed provider package never prompts for installation", async () => {
		const targetDir = mkdtempSync(join(tmpdir(), "qcp-runtime-test-"));
		writeInstalledPackage(targetDir, "@google/generative-ai");

		await expect(
			ensurePackageGroups({
				commandName: "qcp chat",
				groups: ["provider-gemini"],
				interactive: false,
				targetDir,
			}),
		).resolves.toBeUndefined();
	});

	test("auto-installs missing runtime package groups", async () => {
		const targetDir = mkdtempSync(join(tmpdir(), "qcp-runtime-test-"));
		const commands: string[][] = [];

		await installMissingPackageGroups({
			commandName: "qcp-web",
			groups: ["semantic"],
			targetDir,
			runner: async (command) => {
				commands.push([...command]);
				return {
					ok: true,
					exitCode: 0,
					stdout: "",
					stderr: "",
				};
			},
		});

		expect(commands).toEqual([
			[
				"bun",
				"add",
				"--cwd",
				targetDir,
				"--exact",
				"@libsql/client",
				"@libsql/core",
			],
		]);
	});

	test("auto-install errors include manual install fallback", async () => {
		const targetDir = mkdtempSync(join(tmpdir(), "qcp-runtime-test-"));

		await expect(
			installMissingPackageGroups({
				commandName: "qcp-web",
				groups: ["semantic"],
				targetDir,
				runner: async () => ({
					ok: false,
					exitCode: 1,
					stdout: "",
					stderr: "registry unavailable",
				}),
			}),
		).rejects.toThrow("qcp packages install semantic --yes");
	});

	test("provider runtime audit reports no missing groups when selected provider is installed", () => {
		const targetDir = mkdtempSync(join(tmpdir(), "qcp-runtime-test-"));
		writeInstalledPackage(targetDir, "@google/generative-ai");

		const audit = auditProviderRuntimePackages("gemini", targetDir);

		expect(audit.requiredGroups).toEqual(["provider-gemini"]);
		expect(audit.missingGroups).toEqual([]);
	});

	test("provider runtime audit skips prompts when the selected provider is already available to qcp", () => {
		const audit = auditProviderRuntimePackages("gemini");

		expect(audit.requiredGroups).toEqual(["provider-gemini"]);
		expect(audit.missingGroups).toEqual([]);
	});
});
