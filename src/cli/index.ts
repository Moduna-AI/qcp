#!/usr/bin/env node

/**
 * qcp — Query Companion
 * AI-powered natural language CLI for PostgreSQL
 * https://github.com/Moduna-AI/qcp
 */

import chalk from "chalk";
import { Command } from "commander";
import { printBanner } from "@/output/index.js";
import { QCP_FULL_NAME, QCP_REPO, QCP_VERSION } from "@/version.js";

const program = new Command();

// ─── Root ─────────────────────────────────────────────────────────────────────

program
	.name("qcp")
	.description(`${QCP_FULL_NAME} — AI-powered PostgreSQL natural language CLI`)
	.version(QCP_VERSION, "-v, --version", "Print qcp version")
	.addHelpText(
		"after",
		`
${chalk.bold("Quick start:")}
  ${chalk.cyan("qcp auth")}                       Set up your AI provider API key
  ${chalk.cyan("qcp connect")}                    Connect to your database
  ${chalk.cyan("qcp schema scan")}                Index your database schema
  ${chalk.cyan("qcp ask")} ${chalk.dim('"Your question"')}       Query in plain English
  ${chalk.cyan("qcp chat")}                       Start interactive assistant mode
  ${chalk.cyan("qcp automation")} ${chalk.dim('"Create..."')}   Draft a cloud automation

${chalk.bold("Docs & source:")}
  ${QCP_REPO}
`,
	)
	.showHelpAfterError(true);

// ─── auth ─────────────────────────────────────────────────────────────────────

program
	.command("auth")
	.description("Set up your AI provider API key (interactive wizard)")
	.addHelpText(
		"after",
		`
${chalk.bold("Example:")}
  qcp auth                                  Interactive setup
  qcp config set-key gemini AIza...         Set key directly
  qcp config set-key openai sk-...
  qcp config set-key anthropic sk-ant-...
`,
	)
	.action(async () => {
		const { authCommand } = await import("../commands/auth.js");
		await authCommand();
	});

program
	.command("set <provider> <api-key>", { hidden: true })
	.description("Set an API key for a provider directly")
	.action(async (provider: string, apiKey: string) => {
		const { authSetKey } = await import("../commands/auth.js");
		await authSetKey(provider, apiKey);
	});

// ─── init ─────────────────────────────────────────────────────────────────────

program
	.command("init")
	.description("Initialize qcp config and local project directory")
	.action(async () => {
		const { initCommand } = await import("../commands/init.js");
		await initCommand();
	});

// ─── connect ──────────────────────────────────────────────────────────────────

program
	.command("connect [database-url]")
	.description("Connect to a PostgreSQL-compatible database")
	.option("--name <alias>", "Connection alias, such as prod or staging")
	.option(
		"--type <database-type>",
		"Database type: prisma-postgres, neon, supabase, oracle-postgres, other-postgres",
	)
	.option("--schema <path>", "Local Prisma schema.prisma path")
	.option("--datasource <name>", "Prisma datasource name")
	.addHelpText(
		"after",
		`
${chalk.bold("Example:")}
  qcp connect
  qcp connect --name prod postgres://readonly_user:password@host:5432/mydb
  qcp connect --name staging --type neon postgres://readonly_user:password@host/db
  qcp connect --name prod --type prisma-postgres --schema prisma/schema.prisma --datasource db postgres://readonly_user:password@host/db

${chalk.bold("Tip:")} Create a read-only role for maximum safety:
  CREATE ROLE qcp_readonly;
  GRANT CONNECT ON DATABASE mydb TO qcp_readonly;
  GRANT USAGE ON SCHEMA public TO qcp_readonly;
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO qcp_readonly;
`,
	)
	.action(
		async (
			databaseUrl: string | undefined,
			options: {
				name?: string;
				type?: string;
				schema?: string;
				datasource?: string;
			},
		) => {
			const { connectCommand } = await import("../commands/connect.js");
			await connectCommand(databaseUrl, {
				name: options.name,
				type: options.type,
				schema: options.schema,
				datasource: options.datasource,
			});
		},
	);

// ─── db ───────────────────────────────────────────────────────────────────────

const db = program
	.command("db")
	.description("Manage configured database connections");

db.command("list")
	.description("List configured database connections")
	.action(async () => {
		const { dbListCommand } = await import("../commands/db.js");
		dbListCommand();
	});

db.command("current")
	.description("Show the active database connection")
	.action(async () => {
		const { dbCurrentCommand } = await import("../commands/db.js");
		dbCurrentCommand();
	});

db.command("use <alias>")
	.description("Set the active database connection")
	.action(async (alias: string) => {
		const { dbUseCommand } = await import("../commands/db.js");
		await dbUseCommand(alias);
	});

db.command("remove <alias>")
	.description("Remove a database connection and its local schema cache")
	.option("--yes", "Skip confirmation")
	.action(async (alias: string, options: { yes?: boolean }) => {
		const { dbRemoveCommand } = await import("../commands/db.js");
		await dbRemoveCommand(alias, { yes: options.yes });
	});

// ─── schema ───────────────────────────────────────────────────────────────────

const schema = program
	.command("schema")
	.description("Manage database schema indexing");

schema
	.command("scan")
	.description("Scan database and build schema index (~/.qcp/schemas.json)")
	.option("--database <alias>", "Scan a specific configured database")
	.action(async (options: { database?: string }) => {
		const { schemaScanCommand } = await import("../commands/schema.js");
		await schemaScanCommand({ database: options.database });
	});

schema
	.command("info")
	.description("Show summary of the indexed schema")
	.option(
		"--database <alias>",
		"Show schema for a specific configured database",
	)
	.option("--all", "Show schema summaries for all indexed databases")
	.action(async (options: { database?: string; all?: boolean }) => {
		const { schemaInfoCommand } = await import("../commands/schema.js");
		schemaInfoCommand({ database: options.database, all: options.all });
	});

// ─── ask ──────────────────────────────────────────────────────────────────────

program
	.command("ask <question>")
	.description("Ask a question about your database in plain English")
	.option("--metrics", "Show token usage and timing metrics")
	.option("--verbose", "Show additional generation details")
	.option("--debug", "Show raw LLM output, prompts, and EXPLAIN plan")
	.option("--no-safe-mode", "Skip human approval prompts (advanced users only)")
	.option("--yes", "Auto-approve all safety prompts")
	.addHelpText(
		"after",
		`
${chalk.bold("Examples:")}
  qcp ask "What were our top customers last month?"
  qcp ask "Total revenue by product category" --metrics
  qcp ask "Show me users who signed up this week" --verbose
  qcp ask "Largest orders today" --yes
`,
	)
	.action(
		async (
			question: string,
			options: {
				metrics?: boolean;
				verbose?: boolean;
				debug?: boolean;
				safeMode?: boolean;
				yes?: boolean;
			},
		) => {
			const { askCommand } = await import("../commands/ask.js");
			await askCommand(question, {
				metrics: options.metrics,
				verbose: options.verbose,
				debug: options.debug,
				safeMode: options.safeMode !== false,
				noConfirm: options.yes,
			});
		},
	);

// ─── chat ─────────────────────────────────────────────────────────────────────

program
	.command("chat")
	.description(
		"Start interactive assistant mode — ask multiple questions in a session",
	)
	.option("--yes", "Auto-approve all safety prompts")
	.addHelpText(
		"after",
		`
${chalk.bold("In chat mode:")}
  Type any question about your database in plain English.
  Type /help to see available commands.
  Type /exit or Ctrl+C to quit.

${chalk.bold("Examples:")}
  qcp chat
  qcp chat --yes   (skip approval prompts)
`,
	)
	.action(async (options: { yes?: boolean }) => {
		const { chatCommand } = await import("../commands/chat.js");
		await chatCommand({ noConfirm: options.yes });
	});

// ─── automation ──────────────────────────────────────────────────────────────

const automation = program
	.command("automation")
	.description("Create and manage durable cloud automations")
	.argument("[query...]", "Automation request to draft")
	.option("--test-mode", "Use automation test-mode generation")
	.addHelpText(
		"after",
		`
${chalk.bold("Examples:")}
  qcp automation "Create a daily read-only revenue summary"
  qcp automation status req_123
  qcp automation approve req_123
  qcp automation list
  qcp automation run aut_123
  qcp automation delete aut_123 --yes
  qcp automation test
`,
	)
	.action(
		async (
			queryParts: string[] | undefined,
			options: { testMode?: boolean },
		) => {
			const { automationCommand } = await import("../commands/automation.js");
			await automationCommand(queryParts, { testMode: options.testMode });
		},
	);

automation
	.command("status <request-id>")
	.description("Show draft generation state and setup review")
	.action(async (requestId: string) => {
		const { automationStatusCommand } = await import(
			"../commands/automation.js"
		);
		await automationStatusCommand(requestId);
	});

automation
	.command("approve <request-id>")
	.description("Approve and activate a reviewed automation")
	.action(async (requestId: string) => {
		const { automationApproveCommand } = await import(
			"../commands/automation.js"
		);
		await automationApproveCommand(requestId);
	});

automation
	.command("list")
	.description("List active and draft automations")
	.action(async () => {
		const { automationListCommand } = await import("../commands/automation.js");
		await automationListCommand();
	});

automation
	.command("delete <automation-id>")
	.description("Soft-delete an automation")
	.option("--yes", "Skip confirmation")
	.action(async (automationId: string, options: { yes?: boolean }) => {
		const { automationDeleteCommand } = await import(
			"../commands/automation.js"
		);
		await automationDeleteCommand(automationId, { yes: options.yes });
	});

automation
	.command("run <automation-id>")
	.description("Manually run an active automation")
	.action(async (automationId: string) => {
		const { automationRunCommand } = await import("../commands/automation.js");
		await automationRunCommand(automationId);
	});

automation
	.command("test")
	.description("Run heartbeat automation E2E against the control service")
	.action(async () => {
		const { automationTestCommand } = await import("../commands/automation.js");
		await automationTestCommand();
	});

// ─── explain ─────────────────────────────────────────────────────────────────

program
	.command("explain <question>")
	.description("Show SQL for a question without executing it")
	.option("--plan", "Include PostgreSQL EXPLAIN output")
	.action(async (question: string, options: { plan?: boolean }) => {
		const { explainCommand } = await import("../commands/explain.js");
		await explainCommand(question, { showPlan: options.plan });
	});

// ─── model ────────────────────────────────────────────────────────────────────

const model = program
	.command("model")
	.description("Manage LLM providers and models");

model
	.command("list")
	.description("List all available providers and models")
	.action(async () => {
		const { modelListCommand } = await import("../commands/model.js");
		modelListCommand();
	});

model
	.command("current")
	.description("Show the current provider and model")
	.action(async () => {
		const { modelCurrentCommand } = await import("../commands/model.js");
		modelCurrentCommand();
	});

model
	.command("set <model-or-provider>")
	.description("Switch provider or model")
	.addHelpText(
		"after",
		`
${chalk.bold("Examples:")}
  qcp model set gemini            → gemini-2.5-flash (default)
  qcp model set gemini-2.5-pro
  qcp model set openai            → gpt-4o
  qcp model set gpt-4o-mini
  qcp model set anthropic         → claude-opus-4-5
  qcp model set ollama            → qwen3 (local)
`,
	)
	.action(async (modelOrProvider: string) => {
		const { modelSetCommand } = await import("../commands/model.js");
		modelSetCommand(modelOrProvider);
	});

// ─── config ───────────────────────────────────────────────────────────────────

const configCmd = program
	.command("config")
	.description("View and manage configuration");

configCmd
	.command("show")
	.description("Show current configuration")
	.action(async () => {
		const { configShowCommand } = await import("../commands/config-cmd.js");
		configShowCommand();
	});

configCmd
	.command("set <key> <value>")
	.description("Set a configuration value")
	.addHelpText(
		"after",
		`
${chalk.bold("Keys:")}
  safeMode     true/false   Require approval before sensitive queries
  showSql      true/false   Display generated SQL (default: true)
  showMetrics  true/false   Always show timing/token metrics
  telemetry    true/false   Anonymous usage analytics
  ollamaHost   URL          Ollama server (default: http://localhost:11434)
  prismaSchemaPath PATH     Local Prisma schema.prisma path
  prismaDatasourceName NAME Prisma datasource name
  databaseType prisma-postgres/neon/supabase/oracle-postgres/other-postgres
`,
	)
	.action(async (key: string, value: string) => {
		const { configSetCommand } = await import("../commands/config-cmd.js");
		configSetCommand(key, value);
	});

configCmd
	.command("set-key <provider> <api-key>")
	.description("Save an API key (gemini, openai, anthropic)")
	.action(async (provider: string, apiKey: string) => {
		const { configSetKeyCommand } = await import("../commands/config-cmd.js");
		configSetKeyCommand(provider, apiKey);
	});

// ─── telemetry ────────────────────────────────────────────────────────────────

const telemetry = program
	.command("telemetry")
	.description("Manage anonymous usage telemetry");

telemetry
	.command("on")
	.description("Enable telemetry")
	.action(async () => {
		const { telemetryOnCommand } = await import("../commands/telemetry-cmd.js");
		telemetryOnCommand();
	});

telemetry
	.command("off")
	.description("Disable telemetry")
	.action(async () => {
		const { telemetryOffCommand } = await import(
			"../commands/telemetry-cmd.js"
		);
		telemetryOffCommand();
	});

telemetry
	.command("status")
	.description("Show what is and is not collected")
	.action(async () => {
		const { telemetryStatusCommand } = await import(
			"../commands/telemetry-cmd.js"
		);
		telemetryStatusCommand();
	});

// ─── doctor ───────────────────────────────────────────────────────────────────

program
	.command("doctor")
	.description("Run system diagnostics and health checks")
	.option("--json", "Output as JSON")
	.option("--bundle", "Create a redacted support bundle (qcp-support.zip)")
	.action(async (options: { json?: boolean; bundle?: boolean }) => {
		const { doctorCommand } = await import("../commands/doctor.js");
		await doctorCommand(options);
	});

// ─── Handle no args ───────────────────────────────────────────────────────────

if (process.argv.length === 2) {
	printBanner();
	program.help();
}

// ─── Parse ────────────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((err: unknown) => {
	const message = err instanceof Error ? err.message : String(err);
	console.error(chalk.red("\n  ✗ ") + message);
	process.exit(1);
});
