import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QcpConfig } from "@/types/index.js";
import { auditAskRuntimePackages } from "./ask.js";

function tempStore(): string {
	const dir = mkdtempSync(join(tmpdir(), "qcp-ask-packages-test-"));
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

describe("ask runtime package audit", () => {
	test("skips install prompt when selected ask packages are available", () => {
		const store = tempStore();
		writeInstalledPackage(store, "@google/generative-ai");

		const audit = auditAskRuntimePackages(
			configWith({
				provider: "gemini",
				databaseType: "other-postgres",
			}),
			store,
		);

		expect(audit.requiredGroups).toEqual(["agent", "provider-gemini"]);
		expect(audit.missingGroups).toEqual([]);
	});

	test("reports only Prisma when selected database type needs it", () => {
		const store = tempStore();
		writeInstalledPackage(store, "@google/generative-ai");

		const audit = auditAskRuntimePackages(
			configWith({
				provider: "gemini",
				databaseType: "prisma-postgres",
			}),
			store,
		);

		expect(audit.missingGroups).toEqual(["prisma"]);
	});

	test("reports Neon package group only for Neon databases", () => {
		const store = tempStore();
		writeInstalledPackage(store, "@google/generative-ai");

		const audit = auditAskRuntimePackages(
			configWith({
				provider: "gemini",
				databaseType: "neon",
			}),
			store,
		);

		expect(audit.requiredGroups).toEqual(["agent", "provider-gemini", "neon"]);
		expect(audit.missingGroups).toEqual(["neon"]);
	});

	test("adds semantic package group only when semantic state is enabled", () => {
		const store = tempStore();
		writeInstalledPackage(store, "@google/generative-ai");

		const audit = auditAskRuntimePackages(
			configWith({
				provider: "gemini",
				databaseType: "other-postgres",
			}),
			store,
			true,
		);

		expect(audit.requiredGroups).toEqual([
			"agent",
			"provider-gemini",
			"semantic",
		]);
		expect(audit.missingGroups).toEqual(["semantic"]);
	});
});

function configWith(
	overrides: Pick<QcpConfig, "provider" | "databaseType">,
): QcpConfig {
	return {
		version: "0.1.0",
		installId: "019a0000-0000-7000-8000-000000000000",
		databaseConnections: [],
		databaseType: overrides.databaseType,
		provider: overrides.provider,
		model: "gemini-2.5-flash",
		telemetry: true,
		safeMode: true,
		showSql: true,
		showMetrics: false,
		sensitiveTablePatterns: [],
		apiKeys: {},
	};
}
