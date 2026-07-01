import { describe, expect, test } from "bun:test";
import {
	createPromptCapture,
	type PromptStorage,
	prependPromptCapture,
	readPromptCaptures,
	writePromptCaptures,
} from "./prompt-capture";

class MemoryStorage implements PromptStorage {
	private readonly values = new Map<string, string>();

	getItem(key: string): string | null {
		return this.values.get(key) ?? null;
	}

	setItem(key: string, value: string): void {
		this.values.set(key, value);
	}

	removeItem(key: string): void {
		this.values.delete(key);
	}
}

describe("prompt capture helpers", () => {
	test("trims and captures a prompt", () => {
		const capture = createPromptCapture("  Show table sizes  ", {
			id: "capture-1",
			now: new Date("2026-07-01T00:00:00.000Z"),
		});

		expect(capture).toEqual({
			id: "capture-1",
			text: "Show table sizes",
			createdAt: "2026-07-01T00:00:00.000Z",
		});
	});

	test("ignores empty prompts", () => {
		expect(createPromptCapture("   ")).toBeNull();
	});

	test("round-trips validated captures through storage", () => {
		const storage = new MemoryStorage();
		const capture = createPromptCapture("Find unused indexes", {
			id: "capture-2",
			now: new Date("2026-07-01T00:05:00.000Z"),
		});

		if (capture === null) {
			throw new Error("Expected prompt capture to be created");
		}

		writePromptCaptures(storage, [capture]);

		expect(readPromptCaptures(storage)).toEqual([capture]);
	});

	test("falls back to an empty list for invalid persisted data", () => {
		const storage = new MemoryStorage();
		storage.setItem("qcp.desktop.promptCaptures.v1", '{"id": 1}');

		expect(readPromptCaptures(storage)).toEqual([]);
	});

	test("prepends new captures and applies the history limit", () => {
		const captures = ["one", "two", "three"].map((text, index) => {
			const capture = createPromptCapture(text, {
				id: `capture-${index}`,
				now: new Date("2026-07-01T00:00:00.000Z"),
			});

			if (capture === null) {
				throw new Error("Expected prompt capture to be created");
			}

			return capture;
		});

		const nextCapture = createPromptCapture("latest", {
			id: "capture-latest",
			now: new Date("2026-07-01T00:01:00.000Z"),
		});

		if (nextCapture === null) {
			throw new Error("Expected prompt capture to be created");
		}

		const nextCaptures = prependPromptCapture(captures, nextCapture, 3);

		expect(nextCaptures.map((capture) => capture.id)).toEqual([
			"capture-latest",
			"capture-0",
			"capture-1",
		]);
	});
});
