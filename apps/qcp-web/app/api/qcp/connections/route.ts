import { listQcpWebConnections } from "@moduna/qcp/web";
import { requireAuthenticated } from "~/lib/auth";

export async function GET(): Promise<Response> {
	const unauthorized = await requireAuthenticated();
	if (unauthorized) return unauthorized;
	return Response.json({ connections: listQcpWebConnections() });
}
