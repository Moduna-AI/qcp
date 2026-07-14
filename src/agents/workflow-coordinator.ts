import { Agent } from "@mastra/core/agent";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import {
	buildAuditResource,
	resolveAuditActor,
	writeAuditEvent,
} from "@/logger/audit.js";
import { saveSchemaForConnection, scanSchema } from "@/schema/index.js";
import type {
	ActiveDatabaseConnection,
	DatabaseSchema,
	QcpConfig,
} from "@/types/index.js";
import { createMastraModelConfig } from "./model-config.js";

const workflowIntentSchema = z.object({
	intent: z.enum([
		"schema-refresh",
		"secure-read",
		"schema-refresh-then-secure-read",
		"free-path",
	]),
});

export type WorkflowIntent = z.infer<typeof workflowIntentSchema>["intent"];

export interface WorkflowCoordinatorOptions {
	readonly config: QcpConfig;
	readonly connection: ActiveDatabaseConnection | undefined;
	readonly schema: DatabaseSchema;
	readonly onSchemaRefreshed: (schema: DatabaseSchema) => Promise<void>;
	readonly runFreePath: (question: string) => Promise<string>;
}

export interface WorkflowCoordinatorResult {
	readonly handled: boolean;
	readonly text?: string;
	readonly intent: WorkflowIntent;
}

/** Internal workflow facade owned by QcpSupervisorAgent. */
export class QcpWorkflowCoordinator {
	private readonly options: WorkflowCoordinatorOptions;
	private readonly router: Agent<"qcp-workflow-router">;

	public constructor(options: WorkflowCoordinatorOptions) {
		this.options = options;
		this.router = new Agent({
			id: "qcp-workflow-router",
			name: "QCP Workflow Router",
			instructions: [
				"Classify the user request into exactly one workflow intent.",
				"Use schema-refresh when the user explicitly asks to refresh, rescan, pull, or update schema metadata.",
				"Use secure-read only for a straightforward request to read database data.",
				"Use schema-refresh-then-secure-read only when both are explicitly requested.",
				"Use free-path for chat, configuration, explain, import/export, ambiguous, or complex requests.",
			].join("\n"),
			model: createMastraModelConfig(options.config),
		});
	}

	public async run(question: string): Promise<WorkflowCoordinatorResult> {
		const intent = await this.classify(question);
		if (intent === "free-path") return { handled: false, intent };

		if (
			intent === "schema-refresh" ||
			intent === "schema-refresh-then-secure-read"
		) {
			const schema = await this.runSchemaRefresh();
			if (!schema) {
				return {
					handled: true,
					intent,
					text: "Schema refresh could not be completed safely.",
				};
			}
			if (intent === "schema-refresh") {
				return {
					handled: true,
					intent,
					text: `Schema refreshed for ${schema.databaseName}: ${schema.tableCount} tables are now available.`,
				};
			}
		}

		// The provider agent remains the sole SQL planner/executor. Its tools retain
		// the established AST, privacy, tenant, approval, audit, and redaction checks.
		return { handled: true, intent, text: await this.runSecureRead(question) };
	}

	private async classify(question: string): Promise<WorkflowIntent> {
		try {
			const response = await this.router.generate(question, {
				structuredOutput: { schema: workflowIntentSchema },
				modelSettings: { temperature: 0 },
			});
			return workflowIntentSchema.parse(response.object).intent;
		} catch {
			return "free-path";
		}
	}

	private async runSchemaRefresh(): Promise<DatabaseSchema | null> {
		const connection = this.options.connection;
		if (!connection) return null;
		const scanStep = createStep({
			id: "scan-and-persist-schema",
			inputSchema: z.object({}),
			outputSchema: z.object({ schema: z.custom<DatabaseSchema>() }),
			execute: async () => {
				const schema = await scanSchema(connection.databaseUrl);
				saveSchemaForConnection(connection, schema);
				await writeAuditEvent({
					scope: "schema_change",
					action: "SCHEMA_SCAN",
					actor: resolveAuditActor(this.options.config.installId),
					resource: buildAuditResource({
						installId: this.options.config.installId,
						connectionId: connection.id,
						connectionName: connection.name,
						databaseType: connection.databaseType,
						databaseName: schema.databaseName,
						provider: this.options.config.provider,
						model: this.options.config.model,
					}),
					delta: null,
					outcome: "success",
					metadata: {
						workflowId: "qcp-schema-refresh",
						stepId: "scan-and-persist-schema",
						tableCount: schema.tableCount,
					},
				});
				await this.options.onSchemaRefreshed(schema);
				return { schema };
			},
		});
		const workflow = createWorkflow({
			id: "qcp-schema-refresh",
			inputSchema: z.object({}),
			outputSchema: z.object({ schema: z.custom<DatabaseSchema>() }),
		})
			.then(scanStep)
			.commit();
		const run = await workflow.createRun();
		const result = await run.start({ inputData: {} });
		return result.status === "success" ? result.result.schema : null;
	}

	private async runSecureRead(question: string): Promise<string> {
		const readStep = createStep({
			id: "run-secure-read",
			inputSchema: z.object({ question: z.string().min(1) }),
			outputSchema: z.object({ text: z.string() }),
			execute: async ({ inputData }) => ({
				text: await this.options.runFreePath(inputData.question),
			}),
		});
		const workflow = createWorkflow({
			id: "qcp-secure-read",
			inputSchema: z.object({ question: z.string().min(1) }),
			outputSchema: z.object({ text: z.string() }),
		})
			.then(readStep)
			.commit();
		const run = await workflow.createRun();
		const result = await run.start({ inputData: { question } });
		return result.status === "success"
			? result.result.text
			: "The database read workflow could not complete safely.";
	}
}
