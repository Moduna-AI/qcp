import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	formatInstallCommand,
	getPackageGroupStatus,
	installPackageGroup,
	listPackageGroupStatuses,
	MissingLazyPackageError,
	type PackageCommandRunner,
	providerPackageGroup,
	requirePackageGroup,
} from "./lazy-packages.js";

function tempStore(): string {
	const dir = mkdtempSync(join(tmpdir(), "qcp-packages-test-"));
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ name: "qcp-test-store", type: "module" }),
	);
	return dir;
}

function writeInstalledPackage(store: string, packageName: string): void {
	const packageDir = join(store, "node_modules", ...packageName.split("/"));
	mkdirSync(packageDir, { recursive: true });
	writeFileSync(
		join(packageDir, "package.json"),
		JSON.stringify({ name: packageName, version: "1.0.0", main: "index.js" }),
	);
	writeFileSync(join(packageDir, "index.js"), "export default {};\n");
}

describe("lazy package groups", () => {
	test("maps providers to package groups", () => {
		expect(providerPackageGroup("gemini")).toBe("provider-gemini");
		expect(providerPackageGroup("openai")).toBe("provider-openai");
		expect(providerPackageGroup("anthropic")).toBe("provider-anthropic");
		expect(providerPackageGroup("ollama")).toBe("provider-ollama");
	});

	test("reports missing and installed packages", () => {
		const store = tempStore();
		let status = getPackageGroupStatus("provider-openai", store);
		expect(status.installed).toBe(false);
		expect(status.missingPackages).toEqual(["openai"]);

		writeInstalledPackage(store, "openai");
		status = getPackageGroupStatus("provider-openai", store);
		expect(status.installed).toBe(true);
		expect(status.missingPackages).toEqual([]);
	});

	test("ollama group is installed without npm packages", () => {
		const status = getPackageGroupStatus("provider-ollama", tempStore());
		expect(status.installed).toBe(true);
		expect(status.packages).toEqual([]);
	});

	test("throws typed missing package error with install command", () => {
		const store = tempStore();
		expect(() => requirePackageGroup("provider-gemini", store)).toThrow(
			MissingLazyPackageError,
		);
		try {
			requirePackageGroup("provider-gemini", store);
		} catch (error) {
			expect(error).toBeInstanceOf(MissingLazyPackageError);
			const lazyError = error as MissingLazyPackageError;
			expect(lazyError.installCommand).toBe(
				"qcp packages install provider-gemini --yes",
			);
			expect(lazyError.targetDir).toBe(store);
		}
	});

	test("builds exact bun add command for package installs", async () => {
		const store = tempStore();
		const commands: string[][] = [];
		const runner: PackageCommandRunner = async (command) => {
			commands.push([...command]);
			return { ok: true, exitCode: 0, stdout: "ok", stderr: "" };
		};

		const result = await installPackageGroup({
			group: "provider-anthropic",
			targetDir: store,
			runner,
		});

		expect(result.ok).toBe(true);
		expect(commands).toEqual([
			["bun", "add", "--cwd", store, "--exact", "@anthropic-ai/sdk"],
		]);
	});

	test("lists all groups including telemetry and doctor bundle", () => {
		const groups = listPackageGroupStatuses(tempStore()).map(
			(status) => status.group,
		);
		expect(groups).toContain("telemetry");
		expect(groups).toContain("doctor-bundle");
		expect(groups).toContain("provider-ollama");
	});

	test("formats install commands", () => {
		expect(formatInstallCommand("agent")).toBe(
			"qcp packages install agent --yes",
		);
	});
});
