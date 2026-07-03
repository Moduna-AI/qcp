import type { ToolsInput } from "@mastra/core/agent";
import { importPackageFromStore } from "@/packages/lazy-packages.js";
import { QCP_VERSION } from "@/version.js";

interface McpServerInstance {
	startStdio(): Promise<void>;
}

interface McpServerModule {
	MCPServer: new (config: {
		readonly id?: string;
		readonly name: string;
		readonly version: string;
		readonly description?: string;
		readonly tools: ToolsInput;
	}) => McpServerInstance;
}

export async function startSemanticMcpServer(tools: ToolsInput): Promise<void> {
	const { MCPServer } =
		await importPackageFromStore<McpServerModule>("@mastra/mcp");
	const server = new MCPServer({
		id: "qcp-semantic",
		name: "QCP Semantic Layer",
		version: QCP_VERSION,
		description:
			"Local semantic schema enrichment tools for qcp database agents.",
		tools,
	});
	await server.startStdio();
}
