import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	formatInstallCommand,
	getPackageGroupStatus,
	importPackageFromStore,
	installPackageGroup,
	listPackageGroupStatuses,
	MissingLazyPackageError,
	type PackageCommandRunner,
	providerPackageGroup,
	requirePackageGroup,
	resolveAvailablePackage,
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

function writeInstalledPackageWithoutStoreManifest(
	store: string,
	packageName: string,
): void {
	const packageDir = join(store, "node_modules", ...packageName.split("/"));
	mkdirSync(packageDir, { recursive: true });
	writeFileSync(
		join(packageDir, "package.json"),
		JSON.stringify({
			name: packageName,
			version: "1.0.0",
			exports: {
				".": {
					import: "./dist/index.mjs",
					require: "./dist/index.js",
				},
			},
		}),
	);
	mkdirSync(join(packageDir, "dist"), { recursive: true });
	writeFileSync(join(packageDir, "dist", "index.mjs"), "export default {};\n");
	writeFileSync(join(packageDir, "dist", "index.js"), "module.exports = {};\n");
}

function writeNestedExportPackage(store: string, packageName: string): void {
	const packageDir = join(store, "node_modules", ...packageName.split("/"));
	mkdirSync(packageDir, { recursive: true });
	writeFileSync(
		join(packageDir, "package.json"),
		JSON.stringify({
			name: packageName,
			version: "1.0.0",
			type: "module",
			main: "lib-cjs/node.js",
			exports: {
				".": {
					types: "./lib-esm/node.d.ts",
					import: {
						node: "./lib-esm/node.js",
						default: "./lib-esm/node.js",
					},
					require: "./lib-cjs/node.js",
				},
			},
		}),
	);
	mkdirSync(join(packageDir, "lib-esm"), { recursive: true });
	mkdirSync(join(packageDir, "lib-cjs"), { recursive: true });
	writeFileSync(
		join(packageDir, "lib-esm", "node.js"),
		"export const loadedFrom = 'esm';\n",
	);
	writeFileSync(
		join(packageDir, "lib-cjs", "node.js"),
		"exports.loadedFrom = 'cjs';\n",
	);
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

	test("tracks Neon MCP as a Neon-only package group", () => {
		const store = tempStore();
		let status = getPackageGroupStatus("neon", store);
		expect(status.installed).toBe(false);
		expect(status.missingPackages).toEqual(["@mastra/mcp"]);

		writeInstalledPackage(store, "@mastra/mcp");
		status = getPackageGroupStatus("neon", store);
		expect(status.installed).toBe(true);
		expect(status.missingPackages).toEqual([]);
	});

	test("tracks semantic SQLite and MCP runtime groups", () => {
		const store = tempStore();
		expect(getPackageGroupStatus("semantic", store).missingPackages).toEqual([
			"@libsql/client",
		]);
		expect(
			getPackageGroupStatus("semantic-mcp", store).missingPackages,
		).toEqual(["@mastra/mcp"]);

		writeInstalledPackage(store, "@libsql/client");
		writeInstalledPackage(store, "@mastra/mcp");

		expect(getPackageGroupStatus("semantic", store).installed).toBe(true);
		expect(getPackageGroupStatus("semantic-mcp", store).installed).toBe(true);
	});

	test("built-in groups are installed without npm packages", () => {
		for (const group of ["agent", "provider-ollama"] as const) {
			const status = getPackageGroupStatus(group, tempStore());
			expect(status.installed).toBe(true);
			expect(status.packages).toEqual([]);
		}
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

	test("skips bun add when package group is already installed", async () => {
		const store = tempStore();
		writeInstalledPackage(store, "openai");
		const commands: string[][] = [];
		const runner: PackageCommandRunner = async (command) => {
			commands.push([...command]);
			return { ok: true, exitCode: 0, stdout: "ok", stderr: "" };
		};

		const result = await installPackageGroup({
			group: "provider-openai",
			targetDir: store,
			runner,
		});

		expect(result.ok).toBe(true);
		expect(result.stdout).toContain("already installed");
		expect(commands).toEqual([]);
	});

	test("resolves package store entry point without createRequire manifest support", () => {
		const store = mkdtempSync(join(tmpdir(), "qcp-packages-test-"));
		writeInstalledPackageWithoutStoreManifest(store, "@google/generative-ai");

		expect(resolveAvailablePackage("@google/generative-ai", store)).toBe(
			join(
				store,
				"node_modules",
				"@google",
				"generative-ai",
				"dist",
				"index.mjs",
			),
		);
	});

	test("dynamic imports prefer nested ESM export conditions over CJS main", async () => {
		const store = tempStore();
		writeNestedExportPackage(store, "@libsql/client");

		const module = await importPackageFromStore<{ loadedFrom: string }>(
			"@libsql/client",
			store,
		);

		expect(module.loadedFrom).toBe("esm");
	});

	test("lists all groups including telemetry and doctor bundle", () => {
		const groups = listPackageGroupStatuses(tempStore()).map(
			(status) => status.group,
		);
		expect(groups).toContain("neon");
		expect(groups).toContain("semantic");
		expect(groups).toContain("semantic-mcp");
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
