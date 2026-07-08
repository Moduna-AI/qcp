import inquirer from "inquirer";
import ora from "ora";
import type { ProviderName } from "../types/index.js";
import {
	formatInstallCommand,
	getPackageGroupStatus,
	getPackageStoreDir,
	installPackageGroup,
	type PackageGroup,
	type PackageCommandRunner,
	type PackageGroupStatus,
	providerPackageGroup,
} from "./lazy-packages.js";

export interface PackageGroupsAudit {
	readonly requiredGroups: readonly PackageGroup[];
	readonly missingGroups: readonly PackageGroup[];
	readonly statuses: readonly PackageGroupStatus[];
}

export interface EnsurePackageGroupsOptions {
	readonly commandName: string;
	readonly groups: readonly PackageGroup[];
	readonly verbose?: boolean;
	readonly interactive?: boolean;
	readonly targetDir?: string;
}

export interface InstallMissingPackageGroupsOptions {
	readonly commandName: string;
	readonly groups: readonly PackageGroup[];
	readonly verbose?: boolean;
	readonly targetDir?: string;
	readonly runner?: PackageCommandRunner;
}

export async function ensurePackageGroups(
	options: EnsurePackageGroupsOptions,
): Promise<void> {
	const { missingGroups: missing } = auditPackageGroups(
		options.groups,
		options.targetDir,
	);
	if (missing.length === 0) return;

	const isInteractive = options.interactive ?? isInteractiveTerminal();
	if (!isInteractive) {
		throw new Error(
			formatMissingPackageMessage(
				missing,
				options.commandName,
				options.targetDir,
			),
		);
	}

	const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
		{
			type: "confirm",
			name: "confirmed",
			message: `Install missing qcp runtime package groups for ${options.commandName}: ${missing.join(", ")}?`,
			default: true,
		},
	]);
	if (!confirmed) {
		throw new Error(
			formatMissingPackageMessage(
				missing,
				options.commandName,
				options.targetDir,
			),
		);
	}

	for (const group of missing) {
		const status = getPackageGroupStatus(group, options.targetDir);
		if (status.packages.length === 0) continue;

		const targetDir = options.targetDir ?? getPackageStoreDir();
		const spinner = ora(
			`Installing ${group} packages into ${targetDir}...`,
		).start();
		const result = await installPackageGroup({
			group,
			verbose: options.verbose,
			targetDir: options.targetDir,
		});
		if (!result.ok) {
			spinner.fail(`Failed to install ${group} packages`);
			throw new Error(
				[
					`Failed to install qcp package group: ${group}`,
					`Target directory: ${targetDir}`,
					`Install with: ${formatInstallCommand(group)}`,
					result.stderr.trim() || result.stdout.trim(),
				]
					.filter((line) => line.length > 0)
					.join("\n"),
			);
		}
		spinner.succeed(`Installed ${group} packages`);
	}
}

export async function installMissingPackageGroups(
	options: InstallMissingPackageGroupsOptions,
): Promise<void> {
	const { missingGroups } = auditPackageGroups(options.groups, options.targetDir);
	if (missingGroups.length === 0) return;

	for (const group of missingGroups) {
		const status = getPackageGroupStatus(group, options.targetDir);
		if (status.packages.length === 0) continue;

		const targetDir = options.targetDir ?? getPackageStoreDir();
		const result = await installPackageGroup({
			group,
			verbose: options.verbose,
			targetDir: options.targetDir,
			runner: options.runner,
		});
		if (!result.ok) {
			throw new Error(
				[
					`Failed to install qcp runtime packages for ${options.commandName}.`,
					`Package group: ${group}`,
					`Target directory: ${targetDir}`,
					`Install with: ${formatInstallCommand(group)}`,
					result.stderr.trim() || result.stdout.trim(),
				]
					.filter((line) => line.length > 0)
					.join("\n"),
			);
		}
	}
}

export function auditPackageGroups(
	groups: readonly PackageGroup[],
	targetDir?: string,
): PackageGroupsAudit {
	const requiredGroups = uniqueGroups(groups);
	const statuses = requiredGroups.map((group) =>
		getPackageGroupStatus(group, targetDir),
	);

	return {
		requiredGroups,
		missingGroups: statuses
			.filter((status) => !status.installed)
			.map((status) => status.group),
		statuses,
	};
}

export function auditProviderRuntimePackages(
	provider: ProviderName,
	targetDir?: string,
): PackageGroupsAudit {
	return auditPackageGroups([providerPackageGroup(provider)], targetDir);
}

function formatMissingPackageMessage(
	groups: readonly PackageGroup[],
	commandName: string,
	targetDir = getPackageStoreDir(),
): string {
	return [
		`Missing qcp runtime packages for ${commandName}.`,
		...groups.map((group) => `Run: ${formatInstallCommand(group)}`),
		`Target directory: ${targetDir}`,
	].join("\n");
}

function uniqueGroups(groups: readonly PackageGroup[]): PackageGroup[] {
	return [...new Set(groups)];
}

function isInteractiveTerminal(): boolean {
	return process.stdin.isTTY === true && process.env.CI !== "1";
}
