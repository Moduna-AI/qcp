import type { ToolsInput } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { AmazonMarketingCloudClient } from "@/amc/client.js";
import { resolveAmazonMarketingCloudConnectionConfig } from "@/amc/config.js";
import { assertValidAmazonMarketingCloudSql } from "@/amc/sql-safety.js";
import type { AmcWorkflowExecution } from "@/amc/types.js";
import type {
	ActiveDatabaseConnection,
	DatabaseSchema,
} from "@/types/index.js";
import type {
	DatabaseAgentConfig,
	DatabaseAgentType,
} from "./database-agent.js";
import { AbstractDatabaseAgent } from "./database-agent.js";
import { formatSchemaForDatabaseAgent } from "./database-tools.js";

const amcContextSchema = z.object({
	databaseName: z.string(),
	tableCount: z.number(),
	schemaContext: z.string(),
	region: z.enum(["NA", "EU", "FE"]),
	apiBaseUrl: z.string(),
	instanceId: z.string(),
	advertiserId: z.string(),
	marketplaceId: z.string(),
	executionGuidance: z.string(),
	mcpGuidance: z.string(),
});

const amcSqlValidationOutputSchema = z.object({
	ok: z.boolean(),
	sql: z.string(),
	errors: z.array(z.string()),
});

const amcWorkflowExecutionOutputSchema = z.object({
	workflowExecutionId: z.string(),
	workflowId: z.string().optional(),
	status: z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"]),
	outputS3URI: z.string().optional(),
	errorReason: z.string().optional(),
	warnings: z.array(z.string()).optional(),
});

export interface AmazonMarketingCloudAgentConfig<
	TAgentId extends string = string,
> extends DatabaseAgentConfig<TAgentId> {
	readonly connection: ActiveDatabaseConnection;
	readonly schema: DatabaseSchema;
	readonly tools?: ToolsInput;
	readonly client?: AmazonMarketingCloudClient;
}

export class AmazonMarketingCloudAgent<
	TAgentId extends string = string,
> extends AbstractDatabaseAgent<TAgentId> {
	private readonly amcConfig: AmazonMarketingCloudAgentConfig<TAgentId>;

	public constructor(config: AmazonMarketingCloudAgentConfig<TAgentId>) {
		super({
			...config,
			tools: {
				...(config.tools ?? {}),
				...createAmazonMarketingCloudTools({
					connection: config.connection,
					schema: config.schema,
					client: config.client,
				}),
			},
		});
		this.amcConfig = config;
	}

	public override getDatabaseType(): DatabaseAgentType {
		return "amazon-marketing-cloud";
	}

	protected override getBaseInstructions(): string[] {
		return [
			"You are an Amazon Marketing Cloud agent for qcp.",
			"Translate user requests into safe Amazon Marketing Cloud Presto SQL only when enough AMC data-source context is available.",
			"Use qcp_read_amc_context before guessing data-source names, columns, or AMC capabilities.",
			"Only produce read-only SELECT or WITH queries. Never use DDL, DML, CALL, uploads, audience operations, workflow deletion, schedules, or account administration.",
			"Always validate AMC SQL with qcp_validate_amc_sql before requesting a dry-run or execution.",
			"AMC executions are asynchronous workflow executions. Use explicit time windows and explain when a time window is missing.",
			"Use dry-run validation before real execution. If the user wants terminal output or exports, tell them to use qcp ask with --since/--until and --export as needed.",
			"Summarize results and statuses plainly, including workflowExecutionId when an execution starts.",
		];
	}

	protected getDatabaseInstructions(): string[] {
		const connection = this.amcConfig.connection.amazonMarketingCloud;
		return [
			"SQL dialect: Amazon Marketing Cloud Presto SQL.",
			connection?.region ? `AMC region: ${connection.region}.` : "",
			connection?.marketplaceId
				? `AMC marketplace ID: ${connection.marketplaceId}.`
				: "",
		].filter((instruction) => instruction.length > 0);
	}
}

export interface CreateAmazonMarketingCloudToolsOptions {
	readonly connection: ActiveDatabaseConnection;
	readonly schema: DatabaseSchema;
	readonly client?: AmazonMarketingCloudClient;
}

export function createAmazonMarketingCloudTools(
	options: CreateAmazonMarketingCloudToolsOptions,
): ToolsInput {
	const config = resolveAmazonMarketingCloudConnectionConfig(
		options.connection,
	);
	const client =
		options.client ??
		new AmazonMarketingCloudClient({
			config,
		});

	return {
		qcp_read_amc_context: createTool({
			id: "qcp_read_amc_context",
			description:
				"Read local qcp Amazon Marketing Cloud schema context and AMC execution guidance.",
			inputSchema: z.object({}),
			outputSchema: amcContextSchema,
			mcp: {
				annotations: {
					title: "Read AMC Context",
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: false,
				},
			},
			execute: async () => ({
				databaseName: options.schema.databaseName,
				tableCount: options.schema.tableCount,
				schemaContext: formatSchemaForDatabaseAgent(options.schema),
				region: config.region,
				apiBaseUrl: config.apiBaseUrl,
				instanceId: config.instanceId,
				advertiserId: "[configured]",
				marketplaceId: config.marketplaceId,
				executionGuidance:
					"AMC queries run as asynchronous workflow executions. Generate Presto SELECT/WITH SQL, use explicit time windows, dry-run first, then poll status and download results.",
				mcpGuidance:
					"Hosted Amazon Ads MCP tools are not exposed at runtime in qcp v1. Use the local qcp AMC tools backed by the direct AMC Reporting API.",
			}),
		}),
		qcp_validate_amc_sql: createTool({
			id: "qcp_validate_amc_sql",
			description:
				"Validate that Amazon Marketing Cloud Presto SQL is a single read-only SELECT/WITH statement.",
			inputSchema: z.object({
				sql: z.string(),
			}),
			outputSchema: amcSqlValidationOutputSchema,
			mcp: {
				annotations: {
					title: "Validate AMC SQL",
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: false,
				},
			},
			execute: async ({ sql }) => {
				try {
					const validated = assertValidAmazonMarketingCloudSql(sql);
					return { ok: true, sql: validated, errors: [] };
				} catch (err: unknown) {
					return {
						ok: false,
						sql,
						errors: [err instanceof Error ? err.message : String(err)],
					};
				}
			},
		}),
		qcp_start_amc_workflow_execution: createTool({
			id: "qcp_start_amc_workflow_execution",
			description:
				"Start an AMC workflow execution or dry-run for already validated read-only Presto SQL. Use dryRun=true before dryRun=false.",
			inputSchema: z.object({
				sql: z.string(),
				workflowId: z.string(),
				dryRun: z.boolean().default(true),
				timeWindowStart: z.string(),
				timeWindowEnd: z.string(),
				timeWindowTimeZone: z.string().default("UTC"),
			}),
			outputSchema: amcWorkflowExecutionOutputSchema,
			mcp: {
				annotations: {
					title: "Start AMC Workflow Execution",
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: false,
					openWorldHint: true,
				},
			},
			execute: async (input) => {
				const sql = assertValidAmazonMarketingCloudSql(input.sql);
				return serializeWorkflowExecution(
					await client.createWorkflowExecution({
						sql,
						workflowId: input.workflowId,
						dryRun: input.dryRun,
						timeWindowStart: input.timeWindowStart,
						timeWindowEnd: input.timeWindowEnd,
						timeWindowTimeZone: input.timeWindowTimeZone,
					}),
				);
			},
		}),
		qcp_get_amc_workflow_execution_status: createTool({
			id: "qcp_get_amc_workflow_execution_status",
			description:
				"Read the current status of an AMC workflow execution by workflowExecutionId.",
			inputSchema: z.object({
				workflowExecutionId: z.string(),
			}),
			outputSchema: amcWorkflowExecutionOutputSchema,
			mcp: {
				annotations: {
					title: "Read AMC Execution Status",
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: true,
				},
			},
			execute: async ({ workflowExecutionId }) =>
				serializeWorkflowExecution(
					await client.getWorkflowExecution(workflowExecutionId),
				),
		}),
	};
}

function serializeWorkflowExecution(execution: AmcWorkflowExecution): {
	readonly workflowExecutionId: string;
	readonly workflowId?: string;
	readonly status: AmcWorkflowExecution["status"];
	readonly outputS3URI?: string;
	readonly errorReason?: string;
	readonly warnings?: string[];
} {
	return {
		workflowExecutionId: execution.workflowExecutionId,
		workflowId: execution.workflowId,
		status: execution.status,
		outputS3URI: execution.outputS3URI,
		errorReason: execution.errorReason,
		warnings: execution.warnings ? [...execution.warnings] : undefined,
	};
}
