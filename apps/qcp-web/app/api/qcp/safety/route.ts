import {
	getQcpWebSafetyConfig,
	updateQcpWebSafetyLevel,
} from "@moduna/qcp/web";
import { safetyConfigRequestSchema } from "~/lib/api";
import { requireAuthenticated } from "~/lib/auth";

export async function GET(): Promise<Response> {
	const unauthorized = await requireAuthenticated();
	if (unauthorized) return unauthorized;
	return Response.json(getQcpWebSafetyConfig());
}

export async function POST(request: Request): Promise<Response> {
	const unauthorized = await requireAuthenticated();
	if (unauthorized) return unauthorized;

	const parsed = safetyConfigRequestSchema.safeParse(
		await request.json().catch(() => ({})),
	);
	if (!parsed.success) {
		return Response.json(
			{ error: "Valid safetyLevel is required." },
			{ status: 400 },
		);
	}

	return Response.json(updateQcpWebSafetyLevel(parsed.data.safetyLevel));
}
