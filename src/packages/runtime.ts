import inquirer from "inquirer";
import ora from "ora";
import {
	formatInstallCommand,
	getPackageGroupStatus,
	getPackageStoreDir,
	installPackageGroup,
	type PackageGroup,
} from "./lazy-packages.js";

export interface EnsurePackageGroupsOptions {
	readonly commandName: string;
	readonly groups: readonly PackageGroup[];
	readonly verbose?: boolean;
	readonly interactive?: boolean;
	readonly targetDir?: string;
}

export async function ensurePackageGroups(
	options: EnsurePackageGroupsOptions,
): Promise<void> {
	const missing = uniqueGroups(options.groups).filter(
		(group) => !getPackageGroupStatus(group, options.targetDir).installed,
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
			message: `Install required qcp runtime packages for ${options.commandName}?`,
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
