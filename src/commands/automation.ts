import chalk from "chalk";
import Table from "cli-table3";
import inquirer from "inquirer";
import {
	createAutomationControlClient,
	type AutomationControlApi,
} from "@/automation/control-client.js";
import {
	AutomationConfigError,
	AutomationControlApiError,
} from "@/automation/errors.js";
import type {
	AutomationListItem,
	AutomationMutationResponse,
	AutomationReview,
	AutomationRunRecord,
	AutomationStatusResponse,
} from "@/automation/types.js";
import {
	printError,
	printInfo,
	printSection,
	printSuccess,
	printWarning,
} from "@/output/index.js";

export interface AutomationCommandOptions {
	readonly testMode?: boolean;
}

export interface AutomationDeleteOptions {
	readonly yes?: boolean;
}

export interface AutomationCommandDependencies {
	readonly client?: AutomationControlApi;
}

const HEARTBEAT_TEST_QUERY = "Create a heartbeat test automation";

export async function automationCommand(
	queryParts: readonly string[] | undefined,
	options: AutomationCommandOptions = {},
	dependencies: AutomationCommandDependencies = {},
): Promise<void> {
	const query = queryParts?.join(" ").trim() ?? "";
	if (!query) {
		printError(
			"Automation query is required.",
			'Use `qcp automation "Create a daily read-only report"` or `qcp automation list`.',
		);
		process.exit(1);
	}

	const client = dependencies.client ?? createAutomationControlClient();
	const response = await client.submitDraft({
		query,
		requestedBy: resolveAutomationActor(),
		mode: options.testMode ? "test" : "production",
	});

	printSuccess("Automation draft requested");
	printInfo(`Request ID: ${chalk.cyan(response.requestId)}`);
	printInfo(`Status: ${response.status}`);
	if (response.statusUrl) {
		printInfo(`Status URL: ${response.statusUrl}`);
	}
	printInfo(`Review it with: qcp automation status ${response.requestId}`);
}

export async function automationStatusCommand(
	requestId: string,
	dependencies: AutomationCommandDependencies = {},
): Promise<void> {
	const client = dependencies.client ?? createAutomationControlClient();
	const status = await client.getStatus(requestId);
	printAutomationStatus(status);
}

export async function automationApproveCommand(
	requestId: string,
	dependencies: AutomationCommandDependencies = {},
): Promise<void> {
	const client = dependencies.client ?? createAutomationControlClient();
	const response = await client.approve({
		requestId,
		approvedBy: resolveAutomationActor(),
	});

	printMutationResponse("Automation approved", response);
}

export async function automationListCommand(
	dependencies: AutomationCommandDependencies = {},
): Promise<void> {
	const client = dependencies.client ?? createAutomationControlClient();
	const response = await client.list();
	printAutomationList(response.automations);
}

export async function automationDeleteCommand(
	automationId: string,
	options: AutomationDeleteOptions = {},
	dependencies: AutomationCommandDependencies = {},
): Promise<void> {
	if (!options.yes) {
		const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
			{
				type: "confirm",
				name: "confirmed",
				message: `Soft-delete automation "${automationId}"?`,
				default: false,
			},
		]);

		if (!confirmed) {
			printInfo("Automation was not deleted.");
			return;
		}
	}

	const client = dependencies.client ?? createAutomationControlClient();
	const response = await client.delete({
		automationId,
		deletedBy: resolveAutomationActor(),
	});
	printMutationResponse("Automation deleted", response);
}

export async function automationRunCommand(
	automationId: string,
	dependencies: AutomationCommandDependencies = {},
): Promise<void> {
	const client = dependencies.client ?? createAutomationControlClient();
	const response = await client.run({
		automationId,
		requestedBy: resolveAutomationActor(),
	});
	printMutationResponse("Automation run requested", response);
}

export async function automationTestCommand(
	dependencies: AutomationCommandDependencies = {},
): Promise<void> {
	const client = dependencies.client ?? createAutomationControlClient();

	printSection("Automation Test");
	printInfo("Submitting heartbeat draft");
	const submitted = await client.submitDraft({
		query: HEARTBEAT_TEST_QUERY,
		requestedBy: resolveAutomationActor(),
		mode: "test",
	});
	printInfo(`Request ID: ${submitted.requestId}`);

	const reviewed = await waitForReviewedStatus(client, submitted.requestId);
	printAutomationStatus(reviewed);
	if (reviewed.request.status !== "awaiting_approval") {
		throw new AutomationControlApiError(
			`Heartbeat draft did not reach awaiting_approval: ${reviewed.request.status}`,
		);
	}

	printInfo("Approving heartbeat automation");
	const approved = await client.approve({
		requestId: submitted.requestId,
		approvedBy: resolveAutomationActor(),
	});
	const automationId = await resolveAutomationId(
		client,
		submitted.requestId,
		approved,
	);
	printInfo(`Automation ID: ${automationId}`);

	printInfo("Running heartbeat automation");
	await client.run({
		automationId,
		requestedBy: resolveAutomationActor(),
	});
	const run = await waitForLatestRun(client, submitted.requestId);
	printAutomationRun(run);

	printInfo("Verifying automation appears in list");
	const list = await client.list();
	if (!list.automations.some((automation) => automation.id === automationId)) {
		throw new AutomationControlApiError(
			`Heartbeat automation was not returned by list: ${automationId}`,
		);
	}

	printInfo("Deleting heartbeat automation");
	await client.delete({
		automationId,
		deletedBy: resolveAutomationActor(),
	});

	printSuccess("Automation heartbeat test completed");
}

export function printAutomationStatus(status: AutomationStatusResponse): void {
	printSection("Automation Request");
	console.log(`  Request ID:    ${chalk.cyan(status.request.id)}`);
	console.log(`  Status:        ${formatStatus(status.request.status)}`);
	console.log(`  Mode:          ${status.request.mode}`);
	console.log(`  Requested by:  ${status.request.requestedBy}`);
	console.log(`  Created:       ${status.request.createdAt}`);

	if (status.request.error) {
		printWarning(status.request.error);
	}

	if (status.request.review) {
		printAutomationReview(status.request.review);
	} else {
		printInfo("Review is not ready yet.");
	}

	if (status.definition) {
		printSection("Active Definition");
		console.log(`  Automation ID: ${chalk.cyan(status.definition.id)}`);
		console.log(`  Name:          ${status.definition.name}`);
		console.log(`  Status:        ${formatStatus(status.definition.status)}`);
		console.log(
			`  Next run:      ${status.definition.nextRunAt ?? "manual only"}`,
		);
		console.log(`  Last run:      ${status.definition.lastRunAt ?? "never"}`);
	}

	if (status.latestRun) {
		printAutomationRun(status.latestRun);
	}
}

export function printAutomationReview(review: AutomationReview): void {
	printSection("Setup Review");
	console.log(`  Summary:       ${review.summary}`);
	console.log(`  Trigger:       ${review.trigger}`);
	console.log(`  Action:        ${review.action}`);
	console.log(
		`  Env refs:      ${
			review.requiredEnvVars.length > 0
				? review.requiredEnvVars.join(", ")
				: "none"
		}`,
	);
	console.log(`  Expected:      ${review.expectedRunOutput}`);

	printSection("Safety");
	for (const safety of review.safety) {
		console.log(`  ${chalk.green("ok")} ${safety}`);
	}

	if (review.validationIssues.length > 0) {
		printSection("Validation Issues");
		for (const issue of review.validationIssues) {
			console.log(`  ${chalk.red("x")} ${issue}`);
		}
	}
}

export function printAutomationList(
	automations: readonly AutomationListItem[],
): void {
	if (automations.length === 0) {
		printInfo("No automations found.");
		return;
	}

	printSection("Automations");
	const table = new Table({
		head: ["ID", "Name", "Status", "Trigger", "Last Run", "Next Run"].map(
			(label) => chalk.cyan(label),
		),
		style: {
			head: [],
			border: ["grey"],
			compact: true,
		},
		wordWrap: true,
	});

	for (const automation of automations) {
		table.push([
			automation.id,
			automation.name,
			formatStatus(automation.status),
			automation.trigger,
			automation.lastRunAt ?? "never",
			automation.nextRunAt ?? "manual",
		]);
	}

	console.log(table.toString());
}

function printMutationResponse(
	message: string,
	response: AutomationMutationResponse,
): void {
	if (response.ok) {
		printSuccess(message);
	} else {
		printWarning(response.message ?? message);
	}

	if (response.definition) {
		printInfo(`Automation ID: ${chalk.cyan(response.definition.id)}`);
		printInfo(`Status: ${response.definition.status}`);
	}
	if (response.request) {
		printInfo(`Request ID: ${chalk.cyan(response.request.id)}`);
		printInfo(`Status: ${response.request.status}`);
	}
	if (response.run) {
		printAutomationRun(response.run);
	}
	if (response.message) {
		printInfo(response.message);
	}
}

function printAutomationRun(run: AutomationRunRecord): void {
	printSection("Latest Run");
	console.log(`  Run ID:        ${chalk.cyan(run.id)}`);
	console.log(`  Automation ID: ${run.automationId}`);
	console.log(`  Status:        ${formatStatus(run.status)}`);
	console.log(`  Reason:        ${run.reason}`);
	console.log(`  Started:       ${run.startedAt}`);
	console.log(`  Completed:     ${run.completedAt ?? "pending"}`);
	if (run.error) {
		printWarning(run.error);
	}
}

async function waitForReviewedStatus(
	client: AutomationControlApi,
	requestId: string,
): Promise<AutomationStatusResponse> {
	const maxAttempts = 30;
	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		const status = await client.getStatus(requestId);
		if (
			[
				"awaiting_approval",
				"approved",
				"active",
				"failed",
				"expired",
				"deleted",
			].includes(status.request.status)
		) {
			return status;
		}

		await sleep(1_000);
	}

	throw new AutomationControlApiError(
		`Timed out waiting for automation review: ${requestId}`,
	);
}

async function resolveAutomationId(
	client: AutomationControlApi,
	requestId: string,
	response: AutomationMutationResponse,
): Promise<string> {
	if (response.definition?.id) return response.definition.id;
	if (response.request?.automationId) return response.request.automationId;

	const maxAttempts = 30;
	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		const status = await client.getStatus(requestId);
		if (status.definition?.id) return status.definition.id;
		if (status.request.automationId) return status.request.automationId;
		if (["failed", "expired", "deleted"].includes(status.request.status)) {
			throw new AutomationControlApiError(
				`Automation approval did not activate: ${status.request.status}`,
			);
		}
		await sleep(1_000);
	}

	throw new AutomationControlApiError(
		`Automation was approved but no automation ID was returned: ${requestId}`,
	);
}

async function waitForLatestRun(
	client: AutomationControlApi,
	requestId: string,
): Promise<AutomationRunRecord> {
	const maxAttempts = 30;
	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		const status = await client.getStatus(requestId);
		if (
			status.latestRun &&
			["succeeded", "failed", "skipped"].includes(status.latestRun.status)
		) {
			return status.latestRun;
		}
		await sleep(1_000);
	}

	throw new AutomationControlApiError(
		`Timed out waiting for automation run: ${requestId}`,
	);
}

function formatStatus(status: string): string {
	if (
		["active", "approved", "succeeded", "awaiting_approval"].includes(status)
	) {
		return chalk.green(status);
	}
	if (["failed", "deleted", "expired"].includes(status)) {
		return chalk.red(status);
	}
	if (["running", "generating", "queued"].includes(status)) {
		return chalk.yellow(status);
	}
	return status;
}

function resolveAutomationActor(): string {
	return process.env.USER ?? process.env.USERNAME ?? "qcp-cli";
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function printAutomationConfigHelp(error: unknown): boolean {
	if (error instanceof AutomationConfigError) {
		printError(
			error.message,
			"Set QCP_AUTOMATION_CONTROL_URL to your qcp automation control service.",
		);
		return true;
	}

	return false;
}
