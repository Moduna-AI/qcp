import { cookies } from "next/headers";
import { logoutQcpWeb } from "@moduna/qcp/web";
import { SESSION_COOKIE } from "~/lib/api";

export async function POST(): Promise<Response> {
	logoutQcpWeb();
	const store = await cookies();
	store.delete(SESSION_COOKIE);
	return Response.json({ ok: true });
}
