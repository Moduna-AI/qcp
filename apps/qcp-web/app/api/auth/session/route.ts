import { isAuthenticated } from "~/lib/auth";

export async function GET(): Promise<Response> {
	return Response.json({ authenticated: await isAuthenticated() });
}
