import { describe, expect, test } from "bun:test";
import type { ApprovalReason, SafetyLevel } from "@/types/index.js";
import {
	approvalReasonsForSafetyLevel,
	type DatabaseSafetyToolKind,
	requiresSafetyApproval,
} from "./policy.js";

const sensitiveReason: ApprovalReason = {
	type: "sensitive_table",
	detail: "Accessing potentially sensitive tables: users",
};

describe("safety approval policy", () => {
	test.each([
		["low", "read", [], false],
		["low", "import", [], true],
		["standard", "read", [], false],
		["standard", "read", [sensitiveReason], true],
		["standard", "import", [], true],
		["strict", "read", [], true],
		["strict", "explain", [], true],
		["strict", "performance", [], true],
		["strict", "export", [], true],
		["strict", "import", [], true],
	] satisfies Array<
		[SafetyLevel, DatabaseSafetyToolKind, readonly ApprovalReason[], boolean]
	>)("%s safety %s approval requirement", (safetyLevel, toolKind, approvalReasons, expected) => {
		expect(
			requiresSafetyApproval({
				safetyLevel,
				toolKind,
				approvalReasons,
			}),
		).toBe(expected);
	});

	test("adds a strict mode reason when no risk-specific reason exists", () => {
		const reasons = approvalReasonsForSafetyLevel({
			safetyLevel: "strict",
			toolKind: "export",
			approvalReasons: [],
		});

		expect(reasons).toEqual([
			{
				type: "strict_mode",
				detail:
					"Strict safety level requires approval before exporting database data.",
			},
		]);
	});
});
