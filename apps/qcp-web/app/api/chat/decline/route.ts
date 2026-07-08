import { handleApprovalRequest } from "../approve/route";

export async function POST(request: Request): Promise<Response> {
	return handleApprovalRequest(request, false);
}
