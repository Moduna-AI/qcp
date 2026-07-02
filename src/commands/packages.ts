import chalk from "chalk";
import ora from "ora";
import {
	printError,
	printInfo,
	printSection,
	printSuccess,
} from "@/output/index.js";
import {
	formatInstallCommand,
	getPackageStoreDir,
	installAllPackageGroups,
	installPackageGroup,
	listPackageGroupStatuses,
	PACKAGE_GROUPS,
	type PackageGroup,
} from "@/packages/lazy-packages.js";

export interface PackagesInstallOptions {
	readonly yes?: boolean;
	readonly verbose?: boolean;
}

export function packagesListCommand(): void {
	const statuses = listPackageGroupStatuses();
	printSection("qcp Runtime Packages");
	printInfo(`Store: ${getPackageStoreDir()}`);
	console.log();

	for (const status of statuses) {
		const icon = status.installed ? chalk.green("✓") : chalk.yellow("○");
		const packageList =
			status.packages.length > 0 ? status.packages.join(", ") : "none";
		console.log(
			`  ${icon} ${chalk.bold(status.group)} ${chalk.dim(`(${packageList})`)}`,
		);
		console.log(`    ${chalk.dim(status.description)}`);
		if (!status.installed) {
			console.log(
				`    ${chalk.yellow("missing:")} ${status.missingPackages.join(", ")}`,
			);
			console.log(`    ${chalk.dim(formatInstallCommand(status.group))}`);
		}
	}
	console.log();
}

export async function packagesInstallCommand(
	groupOrAll: string,
	options: PackagesInstallOptions = {},
): Promise<void> {
	const target = parsePackageGroupTarget(groupOrAll);
	if (!target.ok) {
		printError(target.message, `Valid groups: ${validTargets().join(", ")}`);
		process.exit(1);
	}

	if (!options.yes && !process.stdin.isTTY) {
		printError(
			"Package installation requires confirmation.",
			`Run: qcp packages install ${groupOrAll} --yes`,
		);
		process.exit(1);
	}

	if (target.value === "all") {
		await installAll(options);
		return;
	}

	await installOne(target.value, options);
}

type PackageGroupTarget =
	| { readonly ok: true; readonly value: PackageGroup | "all" }
	| { readonly ok: false; readonly message: string };

function parsePackageGroupTarget(value: string): PackageGroupTarget {
	if (value === "all") return { ok: true, value };
	if (value in PACKAGE_GROUPS) {
		return { ok: true, value: value as PackageGroup };
	}
	return { ok: false, message: `Unknown package group: ${value}` };
}

async function installOne(
	group: PackageGroup,
	options: PackagesInstallOptions,
): Promise<void> {
	const packages = PACKAGE_GROUPS[group].packages;
	if (packages.length === 0) {
		printSuccess(`${group} does not require npm packages`);
		return;
	}

	const spinner = ora(
		`Installing ${group} packages into ${getPackageStoreDir()}...`,
	).start();
	const result = await installPackageGroup({
		group,
		verbose: options.verbose,
	});
	if (result.ok) {
		spinner.succeed(`Installed ${group} packages`);
		if (options.verbose && result.stdout.trim()) {
			printInfo(result.stdout.trim());
		}
		return;
	}

	spinner.fail(`Failed to install ${group} packages`);
	printError(
		`Bun exited with code ${result.exitCode}`,
		result.stderr.trim() || result.stdout.trim() || formatInstallCommand(group),
	);
	process.exit(1);
}

async function installAll(options: PackagesInstallOptions): Promise<void> {
	const spinner = ora(
		`Installing all qcp runtime packages into ${getPackageStoreDir()}...`,
	).start();
	const results = await installAllPackageGroups({
		verbose: options.verbose,
	});
	const failed = results.find((result) => !result.ok);
	if (!failed) {
		spinner.succeed("Installed all qcp runtime packages");
		return;
	}

	spinner.fail("Failed to install all qcp runtime packages");
	printError(
		`Bun exited with code ${failed.exitCode}`,
		failed.stderr.trim() || failed.stdout.trim(),
	);
	process.exit(1);
}

function validTargets(): string[] {
	return ["all", ...Object.keys(PACKAGE_GROUPS)].sort();
}
