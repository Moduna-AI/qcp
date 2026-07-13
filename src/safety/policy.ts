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

const TOOL_KIND_LABELS: Record<DatabaseSafetyToolKind, string> = {
	read: "executing read queries",
	explain: "running EXPLAIN",
	performance: "analyzing query performance",
	export: "exporting database data",
	import: "importing database data",
};

export function isSafetyLevel(value: string): value is SafetyLevel {
	return (SAFETY_LEVELS as readonly string[]).includes(value);
}

export function requiresSafetyApproval(
	input: SafetyApprovalPolicyInput,
): boolean {
	if (input.safetyLevel === "strict" || input.toolKind === "import")
		return true;
	return (
		input.safetyLevel === "standard" && (input.approvalReasons?.length ?? 0) > 0
	);
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
			detail: `Strict safety level requires approval before ${TOOL_KIND_LABELS[input.toolKind]}.`,
		});
	}
	return reasons;
}
