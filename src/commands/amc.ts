import { AmazonMarketingCloudClient } from "@/amc/client.js";
import { resolveAmazonMarketingCloudConnectionConfig } from "@/amc/config.js";
import {
	getActiveDatabaseConnection,
	loadConfig,
	saveConfig,
} from "@/config/index.js";
import { printError, printInfo, printSection } from "@/output/index.js";

export async function amcStatusCommand(
	workflowExecutionId: string,
): Promise<void> {
	const config = loadConfig();
	const connection = getActiveDatabaseConnection(config);
	if (connection?.databaseType !== "amazon-marketing-cloud") {
		printError(
			"No active Amazon Marketing Cloud connection configured.",
			"Run: qcp connect --type amazon-marketing-cloud",
		);
		process.exit(1);
	}

	const client = new AmazonMarketingCloudClient({
		config: resolveAmazonMarketingCloudConnectionConfig(connection),
		onTokenRefresh: (accessToken, accessTokenExpiresAt) => {
			const databaseConnections = config.databaseConnections.map((candidate) =>
				candidate.id === connection.id && candidate.amazonMarketingCloud
					? {
							...candidate,
							amazonMarketingCloud: {
								...candidate.amazonMarketingCloud,
								accessToken,
								accessTokenExpiresAt,
							},
						}
					: candidate,
			);
			saveConfig({ ...config, databaseConnections });
		},
	});

	try {
		const execution = await client.getWorkflowExecution(workflowExecutionId);
		printSection("AMC Execution");
		console.log(`  Execution:   ${execution.workflowExecutionId}`);
		if (execution.workflowId)
			console.log(`  Workflow:    ${execution.workflowId}`);
		console.log(`  Status:      ${execution.status}`);
		if (execution.outputS3URI)
			console.log(`  Output S3:   ${execution.outputS3URI}`);
		if (execution.createdTime)
			console.log(`  Created:     ${execution.createdTime}`);
		if (execution.updatedTime)
			console.log(`  Updated:     ${execution.updatedTime}`);
		if (execution.errorReason)
			console.log(`  Error:       ${execution.errorReason}`);
		if (execution.warnings && execution.warnings.length > 0) {
			printInfo(`Warnings: ${execution.warnings.join("; ")}`);
		}
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		printError(message);
		process.exit(1);
	}
}
