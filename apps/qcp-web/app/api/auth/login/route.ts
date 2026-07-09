import { loginQcpWeb, QcpWebAuthError } from "@moduna/qcp/web";
import { cookies } from "next/headers";
import { loginRequestSchema, SESSION_COOKIE } from "~/lib/api";

export async function POST(request: Request): Promise<Response> {
	const parsed = loginRequestSchema.safeParse(
		await request.json().catch(() => ({})),
	);
	if (!parsed.success) {
		return Response.json({ error: "Passcode is required." }, { status: 400 });
	}

	try {
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
			return Response.json({ error: error.message }, { status: 401 });
		}
		const message = error instanceof Error ? error.message : String(error);
		return Response.json({ error: message }, { status: 500 });
	}
}
