import { expect, test } from "bun:test";
import { shutdownPostHogSilently } from "./index.js";

test("telemetry shutdown suppresses SDK flush errors", async () => {
	const originalConsoleError = console.error;
	const visibleErrors: unknown[][] = [];
	console.error = (...args: unknown[]) => visibleErrors.push(args);
	try {
		await shutdownPostHogSilently({
			shutdown: async () => {
				console.error("PostHog flush failed");
				throw new Error("network unavailable");
			},
		});
		console.error("visible");
	} finally {
		console.error = originalConsoleError;
	}

	expect(visibleErrors).toEqual([["visible"]]);
});
