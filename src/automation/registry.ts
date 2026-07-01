import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { AutomationRegistryError } from "./errors.js";
import { getNextRunAt, isAutomationDue } from "./schedule.js";
import { describeAutomationAction, describeAutomationTrigger } from "./spec.js";
import {
	AutomationDefinitionRecordSchema,
	AutomationListItemSchema,
	AutomationRequestRecordSchema,
	AutomationRunRecordSchema,
	type AutomationDefinitionRecord,
	type AutomationListItem,
	type AutomationReview,
	type AutomationRequestRecord,
	type AutomationRunRecord,
	type AutomationSpecV1,
	type AutomationRequestedEvent,
	type AutomationRunStatus,
} from "./types.js";

export interface AutomationRegistry {
	ensureSchema(): Promise<void>;
	upsertRequest(input: AutomationRequestedEvent): Promise<void>;
	markRequestGenerating(requestId: string): Promise<void>;
	storeReview(input: StoreAutomationReviewInput): Promise<void>;
	markRequestFailed(requestId: string, error: string): Promise<void>;
	approveRequest(input: ApproveAutomationRequestInput): Promise<void>;
	activateRequest(requestId: string): Promise<AutomationDefinitionRecord>;
	listAutomations(): Promise<readonly AutomationListItem[]>;
	getRequest(requestId: string): Promise<AutomationRequestRecord | null>;
	getDefinition(
		automationId: string,
	): Promise<AutomationDefinitionRecord | null>;
	softDeleteAutomation(input: DeleteAutomationInput): Promise<void>;
	listDueAutomations(at: Date): Promise<readonly AutomationDefinitionRecord[]>;
	recordRunStarted(
		input: StartAutomationRunInput,
	): Promise<AutomationRunRecord>;
	recordRunSucceeded(
		runId: string,
		output: Record<string, unknown>,
	): Promise<AutomationRunRecord>;
	recordRunFailed(runId: string, error: string): Promise<AutomationRunRecord>;
	getLatestRun(automationId: string): Promise<AutomationRunRecord | null>;
}

export interface StoreAutomationReviewInput {
	readonly requestId: string;
	readonly spec: AutomationSpecV1;
	readonly review: AutomationReview;
	readonly validationIssues: readonly string[];
}

export interface ApproveAutomationRequestInput {
	readonly requestId: string;
	readonly approvedBy: string;
	readonly approvedAt: string;
}

export interface DeleteAutomationInput {
	readonly automationId: string;
	readonly deletedBy: string;
	readonly deletedAt: string;
}

export interface StartAutomationRunInput {
	readonly automationId: string;
	readonly reason: "manual" | "cron" | "test";
	readonly startedAt: string;
}

export class PostgresAutomationRegistry implements AutomationRegistry {
	private readonly databaseUrl: string;
	private sqlClient?: ReturnType<typeof postgres>;

	public constructor(databaseUrl: string) {
		this.databaseUrl = databaseUrl;
	}

	public async ensureSchema(): Promise<void> {
		const sql = await this.getSql();
		await sql`
			create table if not exists qcp_automation_requests (
				id text primary key,
				query text not null,
				requested_by text not null,
				status text not null,
				mode text not null,
				spec jsonb,
				review jsonb,
				validation_issues jsonb not null default '[]'::jsonb,
				automation_id text,
				error text,
				created_at timestamptz not null,
				updated_at timestamptz not null,
				approved_at timestamptz,
				approved_by text
			)
		`;
		await sql`
			create table if not exists qcp_automation_definitions (
				id text primary key,
				request_id text not null references qcp_automation_requests(id),
				name text not null,
				status text not null,
				spec jsonb not null,
				review jsonb not null,
				created_at timestamptz not null,
				updated_at timestamptz not null,
				next_run_at timestamptz,
				last_run_at timestamptz,
				deleted_at timestamptz,
				deleted_by text
			)
		`;
		await sql`
			create table if not exists qcp_automation_runs (
				id text primary key,
				automation_id text not null references qcp_automation_definitions(id),
				status text not null,
				reason text not null,
				started_at timestamptz not null,
				completed_at timestamptz,
				output jsonb,
				error text
			)
		`;
	}

	public async upsertRequest(input: AutomationRequestedEvent): Promise<void> {
		const sql = await this.getSql();
		await sql`
			insert into qcp_automation_requests (
				id,
				query,
				requested_by,
				status,
				mode,
				created_at,
				updated_at
			)
			values (
				${input.requestId},
				${input.query},
				${input.requestedBy},
				${"queued"},
				${input.mode},
				${input.createdAt},
				${input.createdAt}
			)
			on conflict (id) do update set
				query = excluded.query,
				requested_by = excluded.requested_by,
				mode = excluded.mode,
				updated_at = excluded.updated_at
		`;
	}

	public async markRequestGenerating(requestId: string): Promise<void> {
		await this.updateRequestStatus(requestId, "generating");
	}

	public async storeReview(input: StoreAutomationReviewInput): Promise<void> {
		const sql = await this.getSql();
		await sql`
			update qcp_automation_requests
			set
				status = ${input.validationIssues.length === 0 ? "awaiting_approval" : "failed"},
				spec = ${sql.json(input.spec)},
				review = ${sql.json(input.review)},
				validation_issues = ${sql.json([...input.validationIssues])},
				error = ${input.validationIssues.length === 0 ? null : input.validationIssues.join("; ")},
				updated_at = ${new Date().toISOString()}
			where id = ${input.requestId}
		`;
	}

	public async markRequestFailed(
		requestId: string,
		error: string,
	): Promise<void> {
		const sql = await this.getSql();
		await sql`
			update qcp_automation_requests
			set
				status = ${"failed"},
				error = ${error},
				updated_at = ${new Date().toISOString()}
			where id = ${requestId}
		`;
	}

	public async approveRequest(
		input: ApproveAutomationRequestInput,
	): Promise<void> {
		const request = await this.getRequest(input.requestId);
		if (!request) {
			throw new AutomationRegistryError(
				`Automation request not found: ${input.requestId}`,
			);
		}
		if (!request.spec || !request.review) {
			throw new AutomationRegistryError(
				`Automation request has no reviewed spec: ${input.requestId}`,
			);
		}
		if (request.validationIssues.length > 0) {
			throw new AutomationRegistryError(
				`Automation request has validation issues: ${request.validationIssues.join("; ")}`,
			);
		}

		const sql = await this.getSql();
		await sql`
			update qcp_automation_requests
			set
				status = ${"approved"},
				approved_by = ${input.approvedBy},
				approved_at = ${input.approvedAt},
				updated_at = ${input.approvedAt}
			where id = ${input.requestId}
		`;
	}

	public async activateRequest(
		requestId: string,
	): Promise<AutomationDefinitionRecord> {
		const request = await this.getRequest(requestId);
		if (!request) {
			throw new AutomationRegistryError(
				`Automation request not found: ${requestId}`,
			);
		}
		if (!request.spec || !request.review) {
			throw new AutomationRegistryError(
				`Automation request has not been reviewed: ${requestId}`,
			);
		}
		if (!["approved", "active"].includes(request.status)) {
			throw new AutomationRegistryError(
				`Automation request must be approved before activation: ${requestId}`,
			);
		}

		if (request.automationId) {
			const existing = await this.getDefinition(request.automationId);
			if (existing) return existing;
		}

		const sql = await this.getSql();
		const now = new Date().toISOString();
		const automationId = `aut_${randomUUID()}`;
		const nextRunAt =
			request.spec.trigger.type === "cron"
				? getNextRunAt(request.spec.trigger.cron)?.toISOString()
				: undefined;

		await sql`
			insert into qcp_automation_definitions (
				id,
				request_id,
				name,
				status,
				spec,
				review,
				created_at,
				updated_at,
				next_run_at
			)
			values (
				${automationId},
				${request.id},
				${request.spec.name},
				${"active"},
				${sql.json(request.spec)},
				${sql.json(request.review)},
				${now},
				${now},
				${nextRunAt ?? null}
			)
		`;
		await sql`
			update qcp_automation_requests
			set
				status = ${"active"},
				automation_id = ${automationId},
				updated_at = ${now}
			where id = ${request.id}
		`;

		const definition = await this.getDefinition(automationId);
		if (!definition) {
			throw new AutomationRegistryError(
				`Automation definition was not found after activation: ${automationId}`,
			);
		}

		return definition;
	}

	public async listAutomations(): Promise<readonly AutomationListItem[]> {
		const sql = await this.getSql();
		const definitionRows = await sql<DefinitionRow[]>`
			select *
			from qcp_automation_definitions
			where status = 'active'
			order by created_at desc
		`;
		const requestRows = await sql<RequestRow[]>`
			select *
			from qcp_automation_requests
			where automation_id is null and status <> 'deleted'
			order by created_at desc
		`;
		const definitions = definitionRows.map(mapDefinitionRow);
		const requests = requestRows.map(mapRequestRow);

		return [
			...definitions.map(definitionToListItem),
			...requests.map(requestToListItem),
		];
	}

	public async getRequest(
		requestId: string,
	): Promise<AutomationRequestRecord | null> {
		const sql = await this.getSql();
		const rows = await sql<RequestRow[]>`
			select *
			from qcp_automation_requests
			where id = ${requestId}
			limit 1
		`;
		const row = rows[0];
		return row ? mapRequestRow(row) : null;
	}

	public async getDefinition(
		automationId: string,
	): Promise<AutomationDefinitionRecord | null> {
		const sql = await this.getSql();
		const rows = await sql<DefinitionRow[]>`
			select *
			from qcp_automation_definitions
			where id = ${automationId}
			limit 1
		`;
		const row = rows[0];
		return row ? mapDefinitionRow(row) : null;
	}

	public async softDeleteAutomation(
		input: DeleteAutomationInput,
	): Promise<void> {
		const sql = await this.getSql();
		await sql`
			update qcp_automation_definitions
			set
				status = ${"deleted"},
				deleted_by = ${input.deletedBy},
				deleted_at = ${input.deletedAt},
				updated_at = ${input.deletedAt}
			where id = ${input.automationId}
		`;
	}

	public async listDueAutomations(
		at: Date,
	): Promise<readonly AutomationDefinitionRecord[]> {
		const sql = await this.getSql();
		const rows = await sql<DefinitionRow[]>`
			select *
			from qcp_automation_definitions
			where status = 'active'
				and next_run_at is not null
				and next_run_at <= ${at.toISOString()}
			order by next_run_at asc
			limit 100
		`;

		return rows
			.map(mapDefinitionRow)
			.filter((definition) => isAutomationDue(definition, at));
	}

	public async recordRunStarted(
		input: StartAutomationRunInput,
	): Promise<AutomationRunRecord> {
		const sql = await this.getSql();
		const definition = await this.getDefinition(input.automationId);
		if (!definition) {
			throw new AutomationRegistryError(
				`Automation definition not found: ${input.automationId}`,
			);
		}

		const runId = `run_${randomUUID()}`;
		await sql`
			insert into qcp_automation_runs (
				id,
				automation_id,
				status,
				reason,
				started_at
			)
			values (
				${runId},
				${input.automationId},
				${"running"},
				${input.reason},
				${input.startedAt}
			)
		`;

		const nextRunAt =
			definition.spec.trigger.type === "cron"
				? getNextRunAt(
						definition.spec.trigger.cron,
						new Date(input.startedAt),
					)?.toISOString()
				: undefined;
		await sql`
			update qcp_automation_definitions
			set
				last_run_at = ${input.startedAt},
				next_run_at = ${nextRunAt ?? null},
				updated_at = ${input.startedAt}
			where id = ${input.automationId}
		`;

		const run = await this.getRun(runId);
		if (!run) {
			throw new AutomationRegistryError(
				`Automation run was not found after start: ${runId}`,
			);
		}
		return run;
	}

	public async recordRunSucceeded(
		runId: string,
		output: Record<string, unknown>,
	): Promise<AutomationRunRecord> {
		return this.completeRun(runId, "succeeded", output);
	}

	public async recordRunFailed(
		runId: string,
		error: string,
	): Promise<AutomationRunRecord> {
		return this.completeRun(runId, "failed", undefined, error);
	}

	public async getLatestRun(
		automationId: string,
	): Promise<AutomationRunRecord | null> {
		const sql = await this.getSql();
		const rows = await sql<RunRow[]>`
			select *
			from qcp_automation_runs
			where automation_id = ${automationId}
			order by started_at desc
			limit 1
		`;
		const row = rows[0];
		return row ? mapRunRow(row) : null;
	}

	private async completeRun(
		runId: string,
		status: Extract<AutomationRunStatus, "succeeded" | "failed">,
		output?: Record<string, unknown>,
		error?: string,
	): Promise<AutomationRunRecord> {
		const sql = await this.getSql();
		const completedAt = new Date().toISOString();
		await sql`
			update qcp_automation_runs
			set
				status = ${status},
				completed_at = ${completedAt},
				output = ${output ? sql.json(toPostgresJson(output)) : null},
				error = ${error ?? null}
			where id = ${runId}
		`;
		const run = await this.getRun(runId);
		if (!run) {
			throw new AutomationRegistryError(
				`Automation run was not found after completion: ${runId}`,
			);
		}
		return run;
	}

	private async updateRequestStatus(
		requestId: string,
		status: AutomationRequestRecord["status"],
	): Promise<void> {
		const sql = await this.getSql();
		await sql`
			update qcp_automation_requests
			set
				status = ${status},
				updated_at = ${new Date().toISOString()}
			where id = ${requestId}
		`;
	}

	private async getRun(runId: string): Promise<AutomationRunRecord | null> {
		const sql = await this.getSql();
		const rows = await sql<RunRow[]>`
			select *
			from qcp_automation_runs
			where id = ${runId}
			limit 1
		`;
		const row = rows[0];
		return row ? mapRunRow(row) : null;
	}

	private async getSql(): Promise<ReturnType<typeof postgres>> {
		if (!this.sqlClient) {
			const postgresModule = await import("postgres");
			this.sqlClient = postgresModule.default(this.databaseUrl, { max: 5 });
		}

		return this.sqlClient;
	}
}

export class InMemoryAutomationRegistry implements AutomationRegistry {
	private readonly requests = new Map<string, AutomationRequestRecord>();
	private readonly definitions = new Map<string, AutomationDefinitionRecord>();
	private readonly runs = new Map<string, AutomationRunRecord>();

	public async ensureSchema(): Promise<void> {}

	public async upsertRequest(input: AutomationRequestedEvent): Promise<void> {
		const existing = this.requests.get(input.requestId);
		const createdAt = existing?.createdAt ?? input.createdAt;
		this.requests.set(
			input.requestId,
			AutomationRequestRecordSchema.parse({
				id: input.requestId,
				query: input.query,
				requestedBy: input.requestedBy,
				status: existing?.status ?? "queued",
				mode: input.mode,
				spec: existing?.spec,
				review: existing?.review,
				validationIssues: existing?.validationIssues ?? [],
				automationId: existing?.automationId,
				error: existing?.error,
				createdAt,
				updatedAt: input.createdAt,
				approvedAt: existing?.approvedAt,
				approvedBy: existing?.approvedBy,
			}),
		);
	}

	public async markRequestGenerating(requestId: string): Promise<void> {
		this.updateRequest(requestId, { status: "generating" });
	}

	public async storeReview(input: StoreAutomationReviewInput): Promise<void> {
		this.updateRequest(input.requestId, {
			status:
				input.validationIssues.length === 0 ? "awaiting_approval" : "failed",
			spec: input.spec,
			review: input.review,
			validationIssues: [...input.validationIssues],
			error:
				input.validationIssues.length > 0
					? input.validationIssues.join("; ")
					: undefined,
		});
	}

	public async markRequestFailed(
		requestId: string,
		error: string,
	): Promise<void> {
		this.updateRequest(requestId, {
			status: "failed",
			error,
		});
	}

	public async approveRequest(
		input: ApproveAutomationRequestInput,
	): Promise<void> {
		const request = this.requireRequest(input.requestId);
		if (!request.spec || !request.review) {
			throw new AutomationRegistryError(
				`Automation request has no reviewed spec: ${input.requestId}`,
			);
		}
		if (request.validationIssues.length > 0) {
			throw new AutomationRegistryError(
				`Automation request has validation issues: ${request.validationIssues.join("; ")}`,
			);
		}
		this.updateRequest(input.requestId, {
			status: "approved",
			approvedAt: input.approvedAt,
			approvedBy: input.approvedBy,
		});
	}

	public async activateRequest(
		requestId: string,
	): Promise<AutomationDefinitionRecord> {
		const request = this.requireRequest(requestId);
		if (!request.spec || !request.review) {
			throw new AutomationRegistryError(
				`Automation request has not been reviewed: ${requestId}`,
			);
		}
		if (!["approved", "active"].includes(request.status)) {
			throw new AutomationRegistryError(
				`Automation request must be approved before activation: ${requestId}`,
			);
		}
		if (request.automationId) {
			const existing = this.definitions.get(request.automationId);
			if (existing) return existing;
		}

		const now = new Date().toISOString();
		const automationId = `aut_${randomUUID()}`;
		const definition = AutomationDefinitionRecordSchema.parse({
			id: automationId,
			requestId: request.id,
			name: request.spec.name,
			status: "active",
			spec: request.spec,
			review: request.review,
			createdAt: now,
			updatedAt: now,
			nextRunAt:
				request.spec.trigger.type === "cron"
					? getNextRunAt(request.spec.trigger.cron)?.toISOString()
					: undefined,
		});
		this.definitions.set(automationId, definition);
		this.updateRequest(request.id, {
			status: "active",
			automationId,
		});

		return definition;
	}

	public async listAutomations(): Promise<readonly AutomationListItem[]> {
		return [
			...[...this.definitions.values()]
				.filter((definition) => definition.status === "active")
				.map(definitionToListItem),
			...[...this.requests.values()]
				.filter(
					(request) => !request.automationId && request.status !== "deleted",
				)
				.map(requestToListItem),
		];
	}

	public async getRequest(
		requestId: string,
	): Promise<AutomationRequestRecord | null> {
		return this.requests.get(requestId) ?? null;
	}

	public async getDefinition(
		automationId: string,
	): Promise<AutomationDefinitionRecord | null> {
		return this.definitions.get(automationId) ?? null;
	}

	public async softDeleteAutomation(
		input: DeleteAutomationInput,
	): Promise<void> {
		const definition = this.definitions.get(input.automationId);
		if (!definition) return;

		this.definitions.set(
			input.automationId,
			AutomationDefinitionRecordSchema.parse({
				...definition,
				status: "deleted",
				deletedBy: input.deletedBy,
				deletedAt: input.deletedAt,
				updatedAt: input.deletedAt,
			}),
		);
	}

	public async listDueAutomations(
		at: Date,
	): Promise<readonly AutomationDefinitionRecord[]> {
		return [...this.definitions.values()].filter((definition) =>
			isAutomationDue(definition, at),
		);
	}

	public async recordRunStarted(
		input: StartAutomationRunInput,
	): Promise<AutomationRunRecord> {
		const definition = this.definitions.get(input.automationId);
		if (!definition) {
			throw new AutomationRegistryError(
				`Automation definition not found: ${input.automationId}`,
			);
		}

		const runId = `run_${randomUUID()}`;
		const run = AutomationRunRecordSchema.parse({
			id: runId,
			automationId: input.automationId,
			status: "running",
			reason: input.reason,
			startedAt: input.startedAt,
		});
		this.runs.set(runId, run);

		const nextRunAt =
			definition.spec.trigger.type === "cron"
				? getNextRunAt(
						definition.spec.trigger.cron,
						new Date(input.startedAt),
					)?.toISOString()
				: undefined;
		this.definitions.set(
			definition.id,
			AutomationDefinitionRecordSchema.parse({
				...definition,
				lastRunAt: input.startedAt,
				nextRunAt,
				updatedAt: input.startedAt,
			}),
		);

		return run;
	}

	public async recordRunSucceeded(
		runId: string,
		output: Record<string, unknown>,
	): Promise<AutomationRunRecord> {
		return this.completeRun(runId, "succeeded", output);
	}

	public async recordRunFailed(
		runId: string,
		error: string,
	): Promise<AutomationRunRecord> {
		return this.completeRun(runId, "failed", undefined, error);
	}

	public async getLatestRun(
		automationId: string,
	): Promise<AutomationRunRecord | null> {
		const runs = [...this.runs.values()]
			.filter((run) => run.automationId === automationId)
			.sort(
				(left, right) =>
					Date.parse(right.startedAt) - Date.parse(left.startedAt),
			);
		return runs[0] ?? null;
	}

	private completeRun(
		runId: string,
		status: Extract<AutomationRunStatus, "succeeded" | "failed">,
		output?: Record<string, unknown>,
		error?: string,
	): AutomationRunRecord {
		const run = this.runs.get(runId);
		if (!run) {
			throw new AutomationRegistryError(`Automation run not found: ${runId}`);
		}
		const completed = AutomationRunRecordSchema.parse({
			...run,
			status,
			completedAt: new Date().toISOString(),
			output,
			error,
		});
		this.runs.set(runId, completed);
		return completed;
	}

	private requireRequest(requestId: string): AutomationRequestRecord {
		const request = this.requests.get(requestId);
		if (!request) {
			throw new AutomationRegistryError(
				`Automation request not found: ${requestId}`,
			);
		}
		return request;
	}

	private updateRequest(
		requestId: string,
		update: Partial<AutomationRequestRecord>,
	): void {
		const request = this.requireRequest(requestId);
		this.requests.set(
			requestId,
			AutomationRequestRecordSchema.parse({
				...request,
				...update,
				updatedAt: new Date().toISOString(),
			}),
		);
	}
}

export function createAutomationRegistryFromEnv(): AutomationRegistry {
	const databaseUrl = process.env.QCP_AUTOMATION_DATABASE_URL;
	if (!databaseUrl) {
		throw new AutomationRegistryError(
			"QCP_AUTOMATION_DATABASE_URL is required for the automation registry.",
		);
	}

	return new PostgresAutomationRegistry(databaseUrl);
}

interface RequestRow {
	readonly id: string;
	readonly query: string;
	readonly requested_by: string;
	readonly status: string;
	readonly mode: string;
	readonly spec: unknown | null;
	readonly review: unknown | null;
	readonly validation_issues: unknown;
	readonly automation_id: string | null;
	readonly error: string | null;
	readonly created_at: Date | string;
	readonly updated_at: Date | string;
	readonly approved_at: Date | string | null;
	readonly approved_by: string | null;
}

interface DefinitionRow {
	readonly id: string;
	readonly request_id: string;
	readonly name: string;
	readonly status: string;
	readonly spec: unknown;
	readonly review: unknown;
	readonly created_at: Date | string;
	readonly updated_at: Date | string;
	readonly next_run_at: Date | string | null;
	readonly last_run_at: Date | string | null;
	readonly deleted_at: Date | string | null;
	readonly deleted_by: string | null;
}

interface RunRow {
	readonly id: string;
	readonly automation_id: string;
	readonly status: string;
	readonly reason: string;
	readonly started_at: Date | string;
	readonly completed_at: Date | string | null;
	readonly output: unknown | null;
	readonly error: string | null;
}

function mapRequestRow(row: RequestRow): AutomationRequestRecord {
	return AutomationRequestRecordSchema.parse({
		id: row.id,
		query: row.query,
		requestedBy: row.requested_by,
		status: row.status,
		mode: row.mode,
		spec: row.spec ?? undefined,
		review: row.review ?? undefined,
		validationIssues: row.validation_issues,
		automationId: row.automation_id ?? undefined,
		error: row.error ?? undefined,
		createdAt: toIsoString(row.created_at),
		updatedAt: toIsoString(row.updated_at),
		approvedAt: row.approved_at ? toIsoString(row.approved_at) : undefined,
		approvedBy: row.approved_by ?? undefined,
	});
}

function mapDefinitionRow(row: DefinitionRow): AutomationDefinitionRecord {
	return AutomationDefinitionRecordSchema.parse({
		id: row.id,
		requestId: row.request_id,
		name: row.name,
		status: row.status,
		spec: row.spec,
		review: row.review,
		createdAt: toIsoString(row.created_at),
		updatedAt: toIsoString(row.updated_at),
		nextRunAt: row.next_run_at ? toIsoString(row.next_run_at) : undefined,
		lastRunAt: row.last_run_at ? toIsoString(row.last_run_at) : undefined,
		deletedAt: row.deleted_at ? toIsoString(row.deleted_at) : undefined,
		deletedBy: row.deleted_by ?? undefined,
	});
}

function mapRunRow(row: RunRow): AutomationRunRecord {
	return AutomationRunRecordSchema.parse({
		id: row.id,
		automationId: row.automation_id,
		status: row.status,
		reason: row.reason,
		startedAt: toIsoString(row.started_at),
		completedAt: row.completed_at ? toIsoString(row.completed_at) : undefined,
		output: row.output ?? undefined,
		error: row.error ?? undefined,
	});
}

function definitionToListItem(
	definition: AutomationDefinitionRecord,
): AutomationListItem {
	return AutomationListItemSchema.parse({
		id: definition.id,
		requestId: definition.requestId,
		name: definition.name,
		status: definition.status,
		trigger: describeAutomationTrigger(definition.spec.trigger),
		action: describeAutomationAction(definition.spec.action),
		lastRunAt: definition.lastRunAt,
		nextRunAt: definition.nextRunAt,
	});
}

function requestToListItem(
	request: AutomationRequestRecord,
): AutomationListItem {
	return AutomationListItemSchema.parse({
		id: request.id,
		name: request.spec?.name ?? request.query,
		status: request.status,
		trigger: request.spec
			? describeAutomationTrigger(request.spec.trigger)
			: "Draft generation pending.",
		action: request.spec
			? describeAutomationAction(request.spec.action)
			: "Draft generation pending.",
	});
}

function toIsoString(value: Date | string): string {
	return value instanceof Date
		? value.toISOString()
		: new Date(value).toISOString();
}

function toPostgresJson(value: unknown): postgres.JSONValue {
	return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
