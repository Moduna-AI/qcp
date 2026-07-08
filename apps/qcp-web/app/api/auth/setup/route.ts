import { cookies } from "next/headers";
import {
	initializeQcpWebAuth,
	loginQcpWeb,
	QcpWebAuthError,
} from "@moduna/qcp/web";
import { setupRequestSchema, SESSION_COOKIE } from "~/lib/api";

export async function POST(request: Request): Promise<Response> {
	const parsed = setupRequestSchema.safeParse(
		await request.json().catch(() => ({})),
	);
	if (!parsed.success) {
		return Response.json(
			{ error: "Choose a 4 digit passcode." },
			{ status: 400 },
		);
	}

	try {
		initializeQcpWebAuth(parsed.data.passcode);
		const session = loginQcpWeb(parsed.data.passcode);
		const store = await cookies();
		store.set(SESSION_COOKIE, session.token, {
			expires: new Date(session.expiresAt),
			httpOnly: true,
			path: "/",
			sameSite: "lax",
			secure: false,
		});
		return Response.json({ ok: true, expiresAt: session.expiresAt });
	} catch (error: unknown) {
		if (error instanceof QcpWebAuthError) {
			return Response.json({ error: error.message }, { status: 409 });
		}
		const message = error instanceof Error ? error.message : String(error);
		return Response.json({ error: message }, { status: 500 });
	}
}
