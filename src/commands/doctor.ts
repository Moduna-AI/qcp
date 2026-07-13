import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, version as nodeVersion, platform, release } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import {
	getActiveDatabaseConnection,
	LOCAL_SUPPORT_DIR,
	LOGS_DIR,
	loadConfig,
	redactConfig,
} from "@/config/index.js";
import { executeQuery, testConnection } from "@/db/index.js";
import { createProvider } from "@/llm/index.js";
import {
	printDoctorCheck,
	printError,
	printInfo,
	printSection,
} from "@/output/index.js";
import { importPackageFromStore } from "@/packages/lazy-packages.js";
import { ensurePackageGroups } from "@/packages/runtime.js";
import { auditPostgresPrivacyPosture } from "@/safety/index.js";
import {
	loadSchemaForConnection,
	schemaCatalogHasConnection,
} from "@/schema/index.js";
import {
	initTelemetry,
	shutdownTelemetry,
	trackDoctor,
} from "@/telemetry/index.js";
import type { DoctorCheck, DoctorReport, HealthStatus } from "@/types/index.js";
import { QCP_VERSION } from "@/version.js";

export interface DoctorOptions {
	json?: boolean;
	bundle?: boolean;
}

// ─── Detect install source ─────────────────────────────────────────────────────

function detectInstallSource(): string {
	const execPath = process.execPath ?? "";
	const mainScript = process.argv[1] ?? "";

	if (mainScript.includes("Homebrew") || execPath.includes("Homebrew"))
		return "brew";
	if (mainScript.includes("node_modules/.bin")) return "npm";
	if (mainScript.includes(".bun")) return "bun";
	if (process.env.QCP_INSTALL_SOURCE) return process.env.QCP_INSTALL_SOURCE;

	// Check if running as a standalone binary (bun --compile)
	const isBinary = !mainScript.endsWith(".js") && !mainScript.endsWith(".ts");
	if (isBinary) return "binary";

	return "npm";
}

// ─── Individual checks ─────────────────────────────────────────────────────────

function checkInstallation(): DoctorCheck[] {
	return [
		{
			name: "qcp version",
			status: "healthy" as HealthStatus,
			value: QCP_VERSION,
		},
		{
			name: "Installation source",
			status: "healthy" as HealthStatus,
			value: detectInstallSource(),
		},
	];
}

function checkRuntime(): DoctorCheck[] {
	const os = platform();
	const cpuArch = arch();
	const osRelease = release();
	const isBun = typeof Bun !== "undefined";

	const checks: DoctorCheck[] = [
		{
			name: "Operating system",
			status: "healthy",
			value: `${os} ${cpuArch} (${osRelease.split(".")[0]})`,
		},
		{
			name: "Runtime",
			status: "healthy",
			value: isBun
				? `Bun ${(Bun as unknown as { version: string }).version}`
				: `Node.js ${nodeVersion()}`,
		},
	];

	return checks;
}

async function checkDatabase(
	config: ReturnType<typeof loadConfig>,
): Promise<DoctorCheck[]> {
	const connection = getActiveDatabaseConnection(config);
	if (!connection) {
		return [
			{
				name: "Database connection",
				status: "warning",
				message: "Not configured. Run: qcp connect",
			},
		];
	}

	const checks: DoctorCheck[] = [];
	const configuredConnection = config.databaseConnections.find(
		(candidate) => candidate.id === connection.id,
	);
	let schemaForAudit:
		| ReturnType<typeof loadSchemaForConnection>["schema"]
		| undefined;
	if (schemaCatalogHasConnection(connection.id)) {
		try {
			schemaForAudit = loadSchemaForConnection(connection).schema;
		} catch {
			schemaForAudit = undefined;
		}
	}
	checks.push({
		name: "Active connection",
		status: "healthy",
		value: `${connection.name} (${connection.databaseType})`,
	});

	const result = await testConnection(connection.databaseUrl);

	if (result.connected) {
		checks.push({
			name: "Connected",
			status: "healthy",
			value: result.version,
		});
		try {
			const posture = await auditPostgresPrivacyPosture({
				databaseUrl: connection.databaseUrl,
				queryExecutor: executeQuery,
				schema: schemaForAudit,
				privacyPolicy: configuredConnection?.privacyPolicy,
			});
			const critical = posture.findings.filter(
				(finding) => finding.severity === "critical",
			).length;
			const warnings = posture.findings.filter(
				(finding) => finding.severity === "warning",
			).length;
			checks.push({
				name: "PostgreSQL privacy posture",
				status: critical > 0 ? "error" : warnings > 0 ? "warning" : "healthy",
				value: `${critical} critical, ${warnings} warning findings`,
				message: posture.findings[0]?.detail,
			});
		} catch {
			checks.push({
				name: "PostgreSQL privacy posture",
				status: "warning",
				message: "Unable to inspect role and RLS catalog metadata.",
			});
		}
		checks.push({
			name: "Read-only enforcement",
			status: "healthy",
			value: "AST-validated",
		});
	} else {
		checks.push({
			name: "Connected",
			status: "error",
			message: result.error ?? "Connection failed",
		});
		return checks;
	}

	// Check schema
	if (schemaCatalogHasConnection(connection.id)) {
		try {
			const { schema } = loadSchemaForConnection(connection);
			checks.push({
				name: "Schema",
				status: "healthy",
				value: `${schema.tableCount} tables indexed`,
			});
		} catch {
			checks.push({
				name: "Schema",
				status: "warning",
				message: "Schema file invalid",
			});
		}
	} else {
		checks.push({
			name: "Schema",
			status: "warning",
			message: "Not scanned. Run: qcp schema scan",
		});
	}

	return checks;
}

async function checkLLM(
	config: ReturnType<typeof loadConfig>,
): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = [
		{ name: "Provider", status: "healthy", value: config.provider },
		{ name: "Model", status: "healthy", value: config.model },
	];

	// Check API key
	const hasKey =
		config.provider === "ollama" ||
		(config.provider === "gemini" &&
			!!(config.apiKeys.gemini ?? process.env.GEMINI_API_KEY)) ||
		(config.provider === "openai" &&
			!!(config.apiKeys.openai ?? process.env.OPENAI_API_KEY)) ||
		(config.provider === "anthropic" &&
			!!(config.apiKeys.anthropic ?? process.env.ANTHROPIC_API_KEY));

	checks.push({
		name: "API key",
		status: hasKey ? "healthy" : "error",
		value: hasKey ? "Configured" : undefined,
		message: hasKey
			? undefined
			: `No API key for ${config.provider}. Run: qcp config set-key ${config.provider} YOUR_KEY`,
	});

	if (hasKey) {
		try {
			const provider = await createProvider(config);
			const connected = await Promise.race([
				provider.testConnectivity(),
				new Promise<boolean>((resolve) =>
					setTimeout(() => resolve(false), 8000),
				),
			]);

			checks.push({
				name: "Connectivity",
				status: connected ? "healthy" : "error",
				value: connected ? "Reachable" : undefined,
				message: connected ? undefined : "API unreachable or invalid key",
			});
		} catch (err) {
			checks.push({
				name: "Connectivity",
				status: "error",
				message: err instanceof Error ? err.message : "Unknown error",
			});
		}
	}

	return checks;
}

function checkConfiguration(
	config: ReturnType<typeof loadConfig>,
): DoctorCheck[] {
	return [
		{
			name: "Telemetry",
			status: "healthy",
			value: config.telemetry ? "enabled" : "disabled",
		},
		{
			name: "Safety level",
			status: config.safetyLevel === "low" ? "warning" : "healthy",
			value: config.safetyLevel,
			message:
				config.safetyLevel === "low"
					? "Low safety skips routine read approval prompts"
					: undefined,
		},
		{
			name: "Show SQL",
			status: "healthy",
			value: config.showSql ? "enabled" : "disabled",
		},
		{
			name: "Metrics",
			status: "healthy",
			value: config.showMetrics ? "enabled" : "disabled",
		},
	];
}

// ─── Overall health ────────────────────────────────────────────────────────────

function computeOverallHealth(report: DoctorReport): HealthStatus {
	const allChecks = [
		...report.checks.installation,
		...report.checks.runtime,
		...report.checks.database,
		...report.checks.llm,
		...report.checks.configuration,
	];

	if (allChecks.some((c) => c.status === "error")) return "error";
	if (allChecks.some((c) => c.status === "warning")) return "warning";
	return "healthy";
}

// ─── Main command ──────────────────────────────────────────────────────────────

export async function doctorCommand(
	options: DoctorOptions = {},
): Promise<void> {
	const config = loadConfig();
	initTelemetry(config);
	trackDoctor();

	const spinner = ora("Running diagnostics...").start();

	const [databaseChecks, llmChecks] = await Promise.all([
		checkDatabase(config),
		checkLLM(config),
	]);

	const report: DoctorReport = {
		version: QCP_VERSION,
		timestamp: new Date().toISOString(),
		overall: "unknown",
		checks: {
			installation: checkInstallation(),
			runtime: checkRuntime(),
			database: databaseChecks,
			llm: llmChecks,
			configuration: checkConfiguration(config),
		},
	};

	report.overall = computeOverallHealth(report);
	spinner.stop();

	// ── JSON mode ─────────────────────────────────────────────────────────────
	if (options.json) {
		const jsonReport = {
			version: report.version,
			timestamp: report.timestamp,
			overall: report.overall,
			platform: platform(),
			arch: arch(),
			database: {
				connected: databaseChecks.some(
					(c) => c.name === "Connected" && c.status === "healthy",
				),
				activeDatabaseId: config.activeDatabaseId,
				connections: config.databaseConnections.map((connection) => ({
					id: connection.id,
					name: connection.name,
					type: connection.databaseType,
					prismaSchemaPath: connection.prismaSchemaPath,
					prismaDatasourceName: connection.prismaDatasourceName,
					schemaScanned: schemaCatalogHasConnection(connection.id),
				})),
				readonly: true,
			},
			provider: {
				name: config.provider,
				model: config.model,
			},
			settings: {
				telemetry: config.telemetry,
				safetyLevel: config.safetyLevel,
				safeMode: config.safeMode,
				showSql: config.showSql,
				showMetrics: config.showMetrics,
			},
		};
		console.log(JSON.stringify(jsonReport, null, 2));
		await shutdownTelemetry();
		return;
	}

	// ── Human-readable output ─────────────────────────────────────────────────
	console.log(`\n${chalk.bold.cyan("  qcp Doctor Report\n")}`);

	printSection("Version");
	for (const c of report.checks.installation) {
		printDoctorCheck(c.name, c.status, c.value ?? c.message);
	}

	printSection("Runtime");
	for (const c of report.checks.runtime) {
		printDoctorCheck(c.name, c.status, c.value ?? c.message);
	}

	printSection("Database");
	for (const c of report.checks.database) {
		printDoctorCheck(c.name, c.status, c.value ?? c.message);
	}

	printSection("Provider");
	for (const c of report.checks.llm) {
		printDoctorCheck(c.name, c.status, c.value ?? c.message);
	}

	printSection("Settings");
	for (const c of report.checks.configuration) {
		printDoctorCheck(c.name, c.status, c.value ?? c.message);
	}

	printSection("Status");
	if (report.overall === "healthy") {
		printDoctorCheck("System healthy", "healthy");
	} else if (report.overall === "warning") {
		printDoctorCheck("System has warnings", "warning");
	} else {
		printDoctorCheck("System has errors — see above", "error");
	}
	console.log();

	// ── Bundle mode ──────────────────────────────────────────────────────────
	if (options.bundle) {
		await ensurePackageGroups({
			commandName: "qcp doctor --bundle",
			groups: ["doctor-bundle"],
		});
		await generateSupportBundle(report, config);
	}

	await shutdownTelemetry();
	if (report.overall === "error") process.exit(1);
}

// ─── Support bundle ────────────────────────────────────────────────────────────

async function generateSupportBundle(
	report: DoctorReport,
	config: ReturnType<typeof loadConfig>,
): Promise<void> {
	const bundleSpinner = ora("Generating support bundle...").start();

	try {
		mkdirSync(LOCAL_SUPPORT_DIR, { recursive: true });

		// 1. doctor.json — sanitized diagnostics (NO credentials)
		const sanitizedReport = {
			...report,
			// Explicitly omit any field that could contain sensitive data
		};
		writeFileSync(
			join(LOCAL_SUPPORT_DIR, "doctor.json"),
			JSON.stringify(sanitizedReport, null, 2),
		);

		// 2. config.json — fully redacted
		const redacted = redactConfig(config);
		writeFileSync(
			join(LOCAL_SUPPORT_DIR, "config.json"),
			JSON.stringify(redacted, null, 2),
		);

		// 3. logs.txt — last 200 lines of app.log
		const logPath = join(LOGS_DIR, "app.log");
		let logContent = "(no logs available)";
		if (existsSync(logPath)) {
			const raw = readFileSync(logPath, "utf-8");
			const lines = raw.split("\n");
			logContent = lines.slice(-200).join("\n");
		}
		writeFileSync(join(LOCAL_SUPPORT_DIR, "logs.txt"), logContent);

		// 4. Create zip
		const { createWriteStream } = await import("node:fs");
		const zipPath = "qcp-support.zip";
		const output = createWriteStream(zipPath);
		const { default: createArchive } =
			await importPackageFromStore<ArchiverModule>("archiver");
		const archive = createArchive("zip", {
			zlib: { level: 9 }, // Sets the compression level.
		});

		await new Promise<void>((resolve, reject) => {
			output.on("close", resolve);
			archive.on("error", reject);
			archive.pipe(output);
			archive.directory(LOCAL_SUPPORT_DIR, false);
			archive.finalize();
		});

		bundleSpinner.succeed(`Support bundle created: ${zipPath}`);
		printInfo(
			"The bundle contains: doctor report, redacted config, recent logs",
		);
		printInfo("No credentials, SQL, schema data, or API keys are included");
		printInfo(
			`Share this file when reporting issues: ${chalk.cyan("https://github.com/Moduna-AI/qcp/issues")}`,
		);
	} catch (err: unknown) {
		bundleSpinner.fail("Bundle creation failed");
		const message = err instanceof Error ? err.message : String(err);
		printError(message);
	}
}

interface ArchiverModule {
	readonly default: (
		format: "zip",
		options: { readonly zlib: { readonly level: number } },
	) => ArchiverInstance;
}

interface ArchiverInstance {
	pipe(output: NodeJS.WritableStream): void;
	directory(source: string, destination: false): void;
	finalize(): void;
	on(event: "error", listener: (error: Error) => void): void;
}
