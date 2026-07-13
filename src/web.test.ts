import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createDefaultConfig } from "./config/index.js";
import { validateQcpWebSession } from "./web.js";

describe("qcp-web session security", () => {
	test("rejects expired and legacy server-side sessions", () => {
		const token = "session-token";
		const salt = "session-salt";
		const base = createDefaultConfig();
		const webAuth = {
			passcodeHash: hash("1234", salt),
			passcodeSalt: salt,
			sessionTokenHash: hash(token, salt),
			createdAt: "2026-07-12T00:00:00.000Z",
			updatedAt: "2026-07-12T00:00:00.000Z",
		};

		expect(validateQcpWebSession(token, { ...base, webAuth })).toBe(false);
		expect(
			validateQcpWebSession(token, {
				...base,
				webAuth: { ...webAuth, sessionExpiresAt: "2020-01-01T00:00:00.000Z" },
			}),
		).toBe(false);
	});

	test("accepts only the matching unexpired token", () => {
		const token = "session-token";
		const salt = "session-salt";
		const base = createDefaultConfig();
		const config = {
			...base,
			webAuth: {
				passcodeHash: hash("1234", salt),
				passcodeSalt: salt,
				sessionTokenHash: hash(token, salt),
				sessionExpiresAt: "2999-01-01T00:00:00.000Z",
				createdAt: "2026-07-12T00:00:00.000Z",
				updatedAt: "2026-07-12T00:00:00.000Z",
			},
		};

		expect(validateQcpWebSession(token, config)).toBe(true);
		expect(validateQcpWebSession("wrong-token", config)).toBe(false);
	});
});

function hash(secret: string, salt: string): string {
	return createHash("sha256").update(`${salt}:${secret}`).digest("hex");
}
