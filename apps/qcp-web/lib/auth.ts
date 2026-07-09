import { validateQcpWebSession } from "@moduna/qcp/web";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "./api";

export async function isAuthenticated(): Promise<boolean> {
	const store = await cookies();
	return validateQcpWebSession(store.get(SESSION_COOKIE)?.value);
}

export async function requireAuthenticated(): Promise<Response | undefined> {
	const authenticated = await isAuthenticated();
	if (authenticated) return undefined;
	return Response.json({ error: "Unauthorized" }, { status: 401 });
}
