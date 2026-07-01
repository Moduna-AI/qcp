/**
 * Telemetry Module
 *
 * Privacy guarantees:
 * - Never sends: SQL queries, DB URLs, schema metadata, query results, API keys
 * - Uses anonymous installId (UUIDv7), no machine identifiers
 * - $process_person_profile: false prevents PostHog person profile creation
 * - Only active when user has opted in (default: true on first run)
 */

import { arch, platform } from "node:os";
import type { PostHog } from "posthog-node";
import { importPackageFromStore } from "@/packages/lazy-packages.js";
import type { ProviderName, QcpConfig } from "@/types/index.js";
import { QCP_VERSION } from "@/version.js";

const POSTHOG_KEY = "phc_pLMwKnLTd5oyY6aKwWRjnKwPz2vfXnZuSKnaxyGCbHKk";
const POSTHOG_HOST = "https://us.i.posthog.com";

let _client: PostHog | null = null;
let _config: Pick<QcpConfig, "telemetry" | "installId"> | null = null;
let _lastActiveDateKey = "";

// ─── Initialization ────────────────────────────────────────────────────────────

export function initTelemetry(
	config: Pick<QcpConfig, "telemetry" | "installId">,
): void {
	_config = config;

	if (!config.telemetry) return;

	void initTelemetryClient();
}

export async function shutdownTelemetry(): Promise<void> {
	if (_client) {
		await _client.shutdown();
		_client = null;
	}
}

// ─── Base properties ────────────────────────────────────────────────────────────

function baseProps(): Record<string, string | boolean | null> {
	return {
		version: QCP_VERSION,
		os: platform(),
		arch: arch(),
		// Critical: prevents PostHog from creating/updating person profiles
		$process_person_profile: false,
	};
}

function capture(
	event: string,
	props: Record<string, string | number | boolean | null> = {},
): void {
	if (!_client || !_config?.telemetry) return;

	_client.capture({
		distinctId: _config.installId,
		event,
		properties: { ...baseProps(), ...props },
	});
}

// ─── Event trackers ────────────────────────────────────────────────────────────

export function trackInstall(): void {
	capture("qcp_install");
}

/** Sent at most once per calendar day */
export function trackActive(): void {
	const today = new Date().toISOString().slice(0, 10);
	if (_lastActiveDateKey === today) return;
	_lastActiveDateKey = today;
	capture("qcp_active");
}

export function trackSchemaScan(tableCount: number): void {
	capture("qcp_schema_scan", { table_count: tableCount });
}

export function trackQuery(opts: {
	provider: ProviderName;
	model: string;
	latencyMs: number;
	approved?: boolean;
}): void {
	capture("qcp_query", {
		provider: opts.provider,
		model: opts.model,
		latency_ms: opts.latencyMs,
		approved: opts.approved ?? false,
	});
}

export function trackHumanApproval(approved: boolean): void {
	capture("qcp_human_approval", { approved });
}

export function trackQueryRejected(reason: string): void {
	capture("qcp_query_rejected", { reason });
}

export function trackProviderSelected(
	provider: ProviderName,
	model: string,
): void {
	capture("qcp_provider_selected", { provider, model });
}

export function trackDoctor(): void {
	capture("qcp_doctor");
}

export function trackError(command: string, errorType: string): void {
	capture("qcp_error", { command, error_type: errorType });
}

async function initTelemetryClient(): Promise<void> {
	if (!_config?.telemetry || _client) return;

	try {
		const { PostHog } =
			await importPackageFromStore<PostHogModule>("posthog-node");
		_client = new PostHog(POSTHOG_KEY, {
			host: POSTHOG_HOST,
			flushAt: 10,
			flushInterval: 3000,
		});
		_client.on("error", () => {});
	} catch {
		_client = null;
	}
}

interface PostHogModule {
	readonly PostHog: new (
		apiKey: string,
		options: {
			readonly host: string;
			readonly flushAt: number;
			readonly flushInterval: number;
		},
	) => PostHog;
}
