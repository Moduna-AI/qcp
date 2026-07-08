import { isQcpWebAuthConfigured } from "@moduna/qcp/web";
import { AssistantShell } from "~/components/assistant-shell";
import { LoginForm } from "~/components/login-form";
import { isAuthenticated } from "~/lib/auth";

export default async function Page(): Promise<React.ReactElement> {
	if (await isAuthenticated()) {
		return <AssistantShell />;
	}
	return <LoginForm setupRequired={!isQcpWebAuthConfigured()} />;
}
