import type { ApprovalReason, SafetyLevel } from "@/types/index.js";

export const SAFETY_LEVELS = ["low", "standard", "strict"] as const;

export type DatabaseSafetyToolKind =
	| "read"
	| "explain"
	| "performance"
	| "export"
	| "import";

export interface SafetyApprovalPolicyInput {
	readonly safetyLevel: SafetyLevel;
	readonly toolKind: DatabaseSafetyToolKind;
	readonly approvalReasons?: readonly ApprovalReason[];
}

export function isSafetyLevel(value: string): value is SafetyLevel {
	return (SAFETY_LEVELS as readonly string[]).includes(value);
}

export function requiresSafetyApproval(
	input: SafetyApprovalPolicyInput,
): boolean {
	switch (input.safetyLevel) {
		case "low":
			return input.toolKind === "import";
		case "standard":
			return (
				input.toolKind === "import" || (input.approvalReasons?.length ?? 0) > 0
			);
		case "strict":
			return true;
		default: {
			const _exhaustive: never = input.safetyLevel;
			return _exhaustive;
		}
	}
}

export function approvalReasonsForSafetyLevel(
	input: SafetyApprovalPolicyInput,
): ApprovalReason[] {
	const reasons = [...(input.approvalReasons ?? [])];
	if (!requiresSafetyApproval(input)) return reasons;
	if (
		input.safetyLevel === "strict" &&
		!reasons.some((reason) => reason.type === "strict_mode")
	) {
		reasons.push({
			type: "strict_mode",
			detail: `Strict safety level requires approval before ${toolKindLabel(input.toolKind)}.`,
		});
	}
	return reasons;
}

function toolKindLabel(toolKind: DatabaseSafetyToolKind): string {
	switch (toolKind) {
		case "read":
			return "executing read queries";
		case "explain":
			return "running EXPLAIN";
		case "performance":
			return "analyzing query performance";
		case "export":
			return "exporting database data";
		case "import":
			return "importing database data";
		default: {
			const _exhaustive: never = toolKind;
			return _exhaustive;
		}
	}
}
