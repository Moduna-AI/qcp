import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { QCP_PACKAGES_DIR } from "../config/index.js";
import type { ProviderName } from "../types/index.js";

const runtimeRequire = createRequire(import.meta.url);

export const PACKAGE_GROUPS = {
	agent: {
		description: "Bundled qcp agent runtime; no npm package required",
		packages: [] as const,
	},
	prisma: {
		description: "Prisma MCP tools for Prisma Postgres connections",
		packages: ["@mastra/mcp", "prisma"] as const,
	},
	neon: {
		description: "Neon MCP docs context for Neon Postgres connections",
		packages: ["@mastra/mcp"] as const,
	},
	semantic: {
		description: "Local SQLite/libSQL semantic schema cache",
		packages: ["@libsql/client"] as const,
	},
	"semantic-mcp": {
		description: "Mastra MCP server runtime for qcp semantic tools",
		packages: ["@mastra/mcp"] as const,
	},
	"provider-gemini": {
		description: "Google Gemini SDK",
		packages: ["@google/generative-ai"] as const,
	},
	"provider-openai": {
		description: "OpenAI SDK",
		packages: ["openai"] as const,
	},
	"provider-anthropic": {
		description: "Anthropic SDK",
		packages: ["@anthropic-ai/sdk"] as const,
	},
	"provider-ollama": {
		description: "Ollama local provider; no npm package required",
		packages: [] as const,
	},
	"doctor-bundle": {
		description: "Support bundle zip creation",
		packages: ["archiver"] as const,
	},
	"format-parquet": {
		description: "Parquet database transfer adapter",
		packages: ["parquetjs-lite"] as const,
	},
	"format-sqlite": {
		description: "SQLite .db database transfer adapter",
		packages: ["@libsql/client"] as const,
	},
	"format-pandas": {
		description: "Pandas pickle database transfer adapter",
		packages: ["pyodide"] as const,
	},
	telemetry: {
		description: "Anonymous usage telemetry",
		packages: ["posthog-node"] as const,
	},
} as const;

export type PackageGroup = keyof typeof PACKAGE_GROUPS;

export interface PackageGroupStatus {
	readonly group: PackageGroup;
	readonly description: string;
	readonly packages: readonly string[];
	readonly installed: boolean;
	readonly missingPackages: readonly string[];
}

export interface InstallPackageGroupOptions {
	readonly group: PackageGroup;
	readonly verbose?: boolean;
	readonly runner?: PackageCommandRunner;
	readonly targetDir?: string;
}

export interface PackageCommandResult {
	readonly ok: boolean;
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

interface PackageManifest {
	readonly main?: string;
	readonly module?: string;
	readonly exports?: unknown;
}

export type PackageCommandRunner = (
	command: readonly string[],
	options: { readonly cwd: string },
) => Promise<PackageCommandResult>;

export class MissingLazyPackageError extends Error {
	public readonly group: PackageGroup;
	public readonly missingPackages: readonly string[];
	public readonly installCommand: string;
	public readonly targetDir: string;

	public constructor(details: {
		readonly group: PackageGroup;
		readonly missingPackages: readonly string[];
		readonly installCommand: string;
		readonly targetDir: string;
	}) {
		super(
			[
				`Missing qcp package group: ${details.group}`,
				`Missing packages: ${details.missingPackages.join(", ") || "(none)"}`,
				`Install with: ${details.installCommand}`,
				`Target directory: ${details.targetDir}`,
			].join("\n"),
		);
		this.name = "MissingLazyPackageError";
		this.group = details.group;
		this.missingPackages = details.missingPackages;
		this.installCommand = details.installCommand;
		this.targetDir = details.targetDir;
	}
}

export function providerPackageGroup(provider: ProviderName): PackageGroup {
	switch (provider) {
		case "gemini":
			return "provider-gemini";
		case "openai":
			return "provider-openai";
		case "anthropic":
			return "provider-anthropic";
		case "ollama":
			return "provider-ollama";
		default: {
			const _exhaustive: never = provider;
			return _exhaustive;
		}
	}
}

export function getPackageStoreDir(): string {
	return QCP_PACKAGES_DIR;
}

export function getPackageStoreManifestPath(
	targetDir = QCP_PACKAGES_DIR,
): string {
	return join(targetDir, "package.json");
}

export function listPackageGroupStatuses(
	targetDir = QCP_PACKAGES_DIR,
): PackageGroupStatus[] {
	return packageGroupNames().map((group) =>
		getPackageGroupStatus(group, targetDir),
	);
}

export function getPackageGroupStatus(
	group: PackageGroup,
	targetDir = QCP_PACKAGES_DIR,
): PackageGroupStatus {
	const definition = PACKAGE_GROUPS[group];
	const missingPackages = definition.packages.filter(
		(packageName) => !isPackageInstalled(packageName, targetDir),
	);

	return {
		group,
		description: definition.description,
		packages: definition.packages,
		installed: missingPackages.length === 0,
		missingPackages,
	};
}

export function requirePackageGroup(
	group: PackageGroup,
	targetDir = QCP_PACKAGES_DIR,
): void {
	const status = getPackageGroupStatus(group, targetDir);
	if (status.installed) return;

	throw new MissingLazyPackageError({
		group,
		missingPackages: status.missingPackages,
		installCommand: formatInstallCommand(group),
		targetDir,
	});
}

export async function installPackageGroup(
	options: InstallPackageGroupOptions,
): Promise<PackageCommandResult> {
	const targetDir = options.targetDir ?? QCP_PACKAGES_DIR;
	const status = getPackageGroupStatus(options.group, targetDir);
	if (status.installed) {
		return {
			ok: true,
			exitCode: 0,
			stdout: `Package group already installed: ${options.group}`,
			stderr: "",
		};
	}

	const packages = PACKAGE_GROUPS[options.group].packages;
	ensurePackageStore(targetDir);

	if (packages.length === 0) {
		return {
			ok: true,
			exitCode: 0,
			stdout: "",
			stderr: "",
		};
	}

	const command = ["bun", "add", "--cwd", targetDir, "--exact", ...packages];
	if (options.verbose) {
		console.log(`Installing ${options.group}: ${formatCommand(command)}`);
	}

	const runner = options.runner ?? runPackageCommand;
	const result = await runner(command, { cwd: targetDir });
	if (!result.ok) return result;

	return result;
}

export async function installAllPackageGroups(
	options: Omit<InstallPackageGroupOptions, "group"> = {},
): Promise<PackageCommandResult[]> {
	const results: PackageCommandResult[] = [];
	for (const group of packageGroupNames()) {
		results.push(await installPackageGroup({ ...options, group }));
	}
	return results;
}

export function ensurePackageStore(targetDir = QCP_PACKAGES_DIR): void {
	mkdirSync(targetDir, { recursive: true });
	const manifestPath = getPackageStoreManifestPath(targetDir);
	if (existsSync(manifestPath)) return;

	writeFileSync(
		manifestPath,
		JSON.stringify(
			{
				name: "qcp-runtime-packages",
				private: true,
				type: "module",
				dependencies: {},
			},
			null,
			2,
		),
	);
}

export function resolvePackageFromStore(
	packageName: string,
	targetDir = QCP_PACKAGES_DIR,
): string {
	const manifestPath = getPackageStoreManifestPath(targetDir);
	if (!existsSync(manifestPath)) {
		throw new Error(`qcp package store is not initialized: ${targetDir}`);
	}
	const packageRequire = createRequire(manifestPath);
	return packageRequire.resolve(packageName);
}

export async function importPackageFromStore<TModule>(
	packageName: string,
	targetDir = QCP_PACKAGES_DIR,
): Promise<TModule> {
	const resolved =
		resolvePackageEntryPoint(packageName, targetDir) ??
		resolveAvailablePackage(packageName, targetDir);
	return (await import(resolved)) as TModule;
}

export function resolveAvailablePackage(
	packageName: string,
	targetDir = QCP_PACKAGES_DIR,
): string {
	try {
		return resolvePackageFromStore(packageName, targetDir);
	} catch {
		const storeEntryPoint = resolvePackageEntryPoint(packageName, targetDir);
		if (storeEntryPoint) return storeEntryPoint;

		if (targetDir !== QCP_PACKAGES_DIR) {
			throw new Error(
				`Package not available in qcp package store: ${packageName}`,
			);
		}
		return runtimeRequire.resolve(packageName);
	}
}

function resolvePackageEntryPoint(
	packageName: string,
	targetDir: string,
): string | null {
	const packageDir = join(targetDir, "node_modules", ...packageName.split("/"));
	const manifestPath = join(packageDir, "package.json");
	if (!existsSync(manifestPath)) return null;

	const manifest = readPackageManifest(manifestPath);
	const entryPoint = getPackageEntryPoint(manifest);
	if (!entryPoint) return null;

	const resolved = join(packageDir, entryPoint);
	return existsSync(resolved) ? resolved : null;
}

function readPackageManifest(manifestPath: string): PackageManifest {
	const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
	if (!isRecord(parsed)) return {};

	return {
		main: typeof parsed.main === "string" ? parsed.main : undefined,
		module: typeof parsed.module === "string" ? parsed.module : undefined,
		exports: parsed.exports,
	};
}

function getPackageEntryPoint(manifest: PackageManifest): string | null {
	const exported = getExportEntryPoint(manifest.exports);
	if (exported) return exported;
	return manifest.module ?? manifest.main ?? "index.js";
}

function getExportEntryPoint(exportsField: unknown): string | null {
	if (typeof exportsField === "string")
		return stripRelativePrefix(exportsField);
	if (!isRecord(exportsField)) return null;

	const rootExport = exportsField["."];
	if (typeof rootExport === "string") return stripRelativePrefix(rootExport);
	if (isRecord(rootExport)) {
		const value = getConditionalExportEntryPoint(rootExport);
		if (value) return value;
	}

	const value = getConditionalExportEntryPoint(exportsField);
	if (value) return value;

	return null;
}

function getConditionalExportEntryPoint(
	exportsField: Record<string, unknown>,
): string | null {
	for (const key of ["import", "default", "module", "node", "require"]) {
		const value = exportsField[key];
		if (typeof value === "string") return stripRelativePrefix(value);
		if (isRecord(value)) {
			const nested = getConditionalExportEntryPoint(value);
			if (nested) return nested;
		}
	}

	return null;
}

function stripRelativePrefix(path: string): string {
	return path.startsWith("./") ? path.slice(2) : path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function formatInstallCommand(group: PackageGroup): string {
	return `qcp packages install ${group} --yes`;
}

export function formatCommand(command: readonly string[]): string {
	return command.join(" ");
}

function isPackageInstalled(packageName: string, targetDir: string): boolean {
	try {
		resolveAvailablePackage(packageName, targetDir);
		return true;
	} catch {
		return false;
	}
}

function packageGroupNames(): PackageGroup[] {
	return Object.keys(PACKAGE_GROUPS) as PackageGroup[];
}

async function runPackageCommand(
	command: readonly string[],
	options: { readonly cwd: string },
): Promise<PackageCommandResult> {
	const [executable, ...args] = command;
	if (!executable) {
		return {
			ok: false,
			exitCode: 1,
			stdout: "",
			stderr: "Missing executable",
		};
	}

	return await new Promise<PackageCommandResult>((resolve) => {
		const child = spawn(executable, args, {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf-8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8");
		});
		child.on("error", (error) => {
			resolve({
				ok: false,
				exitCode: 1,
				stdout,
				stderr: error.message,
			});
		});
		child.on("close", (code) => {
			const exitCode = code ?? 1;
			resolve({
				ok: exitCode === 0,
				exitCode,
				stdout,
				stderr,
			});
		});
	});
}
