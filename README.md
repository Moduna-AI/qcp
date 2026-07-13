<div align="center">

# ◆ qcp — Query Companion

**AI-powered natural language interface for PostgreSQL**

[![npm downloads](https://img.shields.io/npm/dm/%40moduna/qcp?label=npm%20downloads)](https://www.npmjs.com/package/@moduna/qcp)
[![Homebrew tap](https://img.shields.io/badge/homebrew-moduna--ai%2Fqcp-blue?logo=homebrew)](https://github.com/moduna-ai/homebrew-qcp)
[![CI](https://github.com/Moduna-AI/qcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Moduna-AI/qcp/actions/workflows/ci.yml)
[![GitHub release](https://img.shields.io/github/v/release/Moduna-AI/qcp?label=release)](https://github.com/Moduna-AI/qcp/releases)
[![Node.js](https://img.shields.io/node/v/%40moduna/qcp?label=node)](package.json)
[![TypeScript](https://img.shields.io/badge/types-TypeScript-blue)](tsconfig.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Ask questions about a PostgreSQL database in plain English. qcp generates SQL,
shows it to you, validates that it is read-only, executes it through a guarded
connection, and returns results with a concise explanation.

</div>

```bash
qcp ask "What were our top customers last month?"
```

```text
Question:
  What were our top customers last month?

Generated SQL:
  SELECT c.name, SUM(o.total) AS revenue
  FROM customers c
  JOIN orders o ON c.id = o.customer_id
  WHERE o.created_at >= date_trunc('month', NOW() - INTERVAL '1 month')
    AND o.created_at < date_trunc('month', NOW())
  GROUP BY c.name
  ORDER BY revenue DESC
  LIMIT 100

Safety:
  ✓ Read-only connection
  ✓ SELECT-only query
  ✓ LIMIT applied
  ✓ Query validated
  ✓ Privacy checks active

Results:
  ┌──────────────────────┬───────────────┐
  │ name                 │ revenue       │
  ├──────────────────────┼───────────────┤
  │ Acme Corporation     │ 125432.00     │
  │ TechCorp Inc         │  98765.00     │
  └──────────────────────┴───────────────┘
  2 row(s) · 48ms

Insight:
  Acme Corporation led last month with $125,432 in revenue, followed by
  TechCorp Inc at $98,765.
```

## Why qcp?

qcp is built for teams that want natural-language access to operational data
without turning an LLM loose on a production database.

- **Transparent SQL**: qcp shows generated SQL before execution.
- **Deterministic safety**: generated SQL is parsed and validated before it can
  run. Write operations, DDL, privilege changes, and unsafe CTEs are rejected.
- **Read-only execution**: database work runs through read-only transactions.
- **Local-first metadata**: schema indexes and semantic annotations are stored
  under `~/.qcp`.
- **Provider choice**: use Gemini, OpenAI, Anthropic, or local Ollama models.
- **Embeddable runtime**: import the SDK from `@moduna/qcp` without invoking the
  CLI.

## Installation

### Homebrew

```bash
brew tap moduna-ai/qcp
brew install qcp
```

### Shell Installer

```bash
curl -fsSL https://raw.githubusercontent.com/Moduna-AI/qcp/main/scripts/install.sh | sh
```

### Windows PowerShell

```powershell
irm https://raw.githubusercontent.com/Moduna-AI/qcp/main/scripts/install.ps1 | iex
```

### Bun

```bash
bun add -g @moduna/qcp
```

## Quick Start

```bash
# Configure Gemini, OpenAI, Anthropic, or Ollama
qcp auth

# Add a named database connection
qcp connect

# Index database structure locally
qcp schema scan

# Optional: add business context for tables and columns
qcp semantic scan
qcp semantic enrich

# Ask a one-off question
qcp ask "Which products have the lowest inventory?"

# Or start an interactive session
qcp chat
```

## Core Commands

| Command | Description |
|---|---|
| `qcp auth` | Configure an LLM provider and API key |
| `qcp connect` | Add or replace a named database connection |
| `qcp db list` | List configured database connections |
| `qcp db current` | Show the active database connection |
| `qcp db use <alias>` | Switch the active database connection |
| `qcp db edit <alias>` | Modify a connection and refresh its schema |
| `qcp db remove <alias>` | Remove a connection and its cached schema |
| `qcp schema scan` | Index structural schema metadata locally |
| `qcp semantic scan` | Sync schema objects into the local semantic store |
| `qcp semantic enrich` | Add human-authored business context |
| `qcp semantic profile <table>` | Opt in to bounded value profiling |
| `qcp ask "<question>"` | Query the active database in plain English |
| `qcp chat` | Start an interactive session |
| `qcp explain "<question>"` | Generate and inspect SQL without executing it |
| `qcp doctor` | Run system diagnostics |

## Non-Interactive Setup

```bash
qcp config set-key gemini YOUR_API_KEY
qcp connect --name prod --type other-postgres postgres://readonly_user:password@host/db
qcp connect --name warehouse --type neon postgres://readonly_user:password@host/db
qcp db use prod
qcp schema scan
qcp ask "How many paid accounts signed up this week?"
```

Database connections are stored in `~/.qcp/config.json`. Structural schema
indexes are stored in `~/.qcp/schemas.json`. Semantic enrichment is stored in
`~/.qcp/semantic.db`.

## Supported Providers

| Provider | Default Model | API Key |
|---|---|---|
| Gemini | `gemini-2.5-flash` | [Google AI Studio](https://aistudio.google.com/app/apikey) |
| OpenAI | `gpt-5.5` | [OpenAI Platform](https://platform.openai.com/api-keys) |
| Anthropic | `claude-opus-4-8` | [Anthropic Console](https://console.anthropic.com) |
| Ollama | `qwen3` | No key required |

```bash
qcp model list
qcp model set gemini
qcp model set openai
qcp model set anthropic
qcp model set ollama
```

## Safety Model

qcp treats model output as untrusted. The model may suggest SQL, but
deterministic code decides whether that SQL is allowed to run.

### SQL Validation

Every generated statement is parsed into an AST before execution.
The command policy targets PostgreSQL 18.

**Allowed**: `SELECT`, `WITH`, `EXPLAIN`

**Rejected**: every other PostgreSQL 18 command family, including data/schema
changes, role and session changes, maintenance commands, cursor/prepared
statement commands, notifications, file/library access, and transaction control.
`SELECT INTO`, row-locking `SELECT`, and `EXPLAIN ANALYZE` are also rejected.

`WITH` queries are inspected internally, so data-changing CTEs such as
`WITH deleted AS (DELETE ...) SELECT ...` are rejected.

### Read-Only Execution

Database reads run inside read-only transactions. qcp also applies approval
prompts for potentially sensitive or high-cost reads when `safeMode` is enabled.

```bash
qcp ask "question" --metrics
qcp ask "question" --verbose
qcp ask "question" --debug
qcp ask "question" --yes
```

Use `--yes` only in trusted local workflows. It skips approval prompts, but it
does not disable SQL validation, read-only transactions, tenant isolation, or
result scrubbing.

### Mastra Tool Containment

Mastra database tools route execution through the same safety pipeline:

1. Validate read-only SQL.
2. Require trusted `requestContext.tenantId` and `requestContext.userId`.
3. Inject tenant/user predicates into supported queries.
4. Execute only rewritten SQL.
5. Scrub sensitive output before returning it to an agent context.
6. Return sanitized errors without raw stack traces or schema dumps.

Direct `qcp ask` execution does not invent a tenant boundary. If a Prisma tool
path has no trusted Mastra request context, execution fails closed.

## Privacy Model

qcp has two separate data flows:

- **LLM provider flow**: qcp sends your question, relevant local schema context,
  and relevant semantic annotations to the configured model provider. Query
  results may be sent to that provider for summarization unless you use a local
  provider such as Ollama.
- **Telemetry flow**: anonymous product telemetry excludes SQL, schema metadata,
  row data, connection URLs, credentials, API keys, and tokens.

Disable telemetry:

```bash
qcp telemetry off
```

`qcp schema scan` reads structure only: table names, column names, types, and
relationships. It does not read row data. `qcp semantic profile` is the only
semantic command that reads values, and it must be invoked for selected
tables/columns.

For the full security posture, supported limits, and vulnerability reporting
process, see [SECURITY.md](SECURITY.md).

## SDK

qcp ships an ESM SDK for Node.js and Bun projects.

```ts
import { createQcpClient } from '@moduna/qcp'

const qcp = createQcpClient()
const answer = await qcp.ask('What tables do you know?')

console.log(answer.text)
```

The SDK uses the same local qcp config, active connection, cached schema,
runtime package store, and read-only guardrails as the CLI. Importing
`@moduna/qcp` has no CLI side effects. Runtime package installation is explicit:
pass `installMissingPackages: true` or call
`installQcpSdkRuntimePackages()` when an embedding app should install missing
provider/runtime packages.

Curated subpath exports are available for lower-level integrations:

```ts
import type { DatabaseSchema } from '@moduna/qcp/types'
import { validateSql } from '@moduna/qcp/safety'
import { scanSchema } from '@moduna/qcp/schema'
import { executeQuery } from '@moduna/qcp/db'
import { listPackageGroupStatuses } from '@moduna/qcp/runtime'
```

## Local Web Assistant

`qcp-web` is a separate opt-in localhost app. It is not installed by the
standard `qcp` CLI installers.

```bash
bun install
bun run build
cd apps/qcp-web
bun run dev
```

On first launch, open the localhost app and choose a local qcp-web passcode.
qcp stores only a hash in `~/.qcp/config.json`. The web app reads the same
`qcp connect` aliases, model provider, API keys, and schema catalog as the CLI.

## Configuration

Settings are stored in `~/.qcp/config.json`.

```json
{
  "provider": "gemini",
  "model": "gemini-2.5-flash",
  "safeMode": true,
  "showSql": true,
  "showMetrics": false,
  "telemetry": true,
  "sensitiveTablePatterns": ["user", "customer", "payment", "billing"],
  "databaseConnections": [{
    "name": "analytics",
    "privacyPolicy": {
      "sensitiveColumns": ["public.customers.health_record"],
      "allowedSensitiveViews": ["analytics.masked_customers"],
      "safeFunctions": ["analytics.safe_bucket"],
      "minimumCohortSize": 10
    }
  }]
}
```

PostgreSQL privacy policies are enforced per named connection at every safety
level. Raw sensitive columns, unsafe or unknown functions, `EXPLAIN ANALYZE`,
and locking reads are rejected. Prefer restricted database views, column
privileges, forced RLS, masking, and encryption; qcp's policy is an additional
application boundary, not a replacement for database permissions. Run
`qcp doctor` or ask the agent to audit PostgreSQL privacy posture for read-only
role and RLS findings.

Environment variables:

```bash
QCP_DATABASE_URL=postgres://...
GEMINI_API_KEY=AIza...
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
OLLAMA_HOST=http://localhost:11434
```

## Local Development

Prerequisites:

- [Bun](https://bun.sh) 1.1 or newer
- Node.js 22 or newer
- A PostgreSQL database for integration testing

```bash
git clone https://github.com/Moduna-AI/qcp
cd qcp

bun install
bun dev -- ask "show me all tables"
bun type-check
bun test
bun run build
```

Project layout:

```text
src/
  index.ts      SDK entry point
  sdk.ts        High-level SDK client
  cli/          CLI entry point
  commands/     Command implementations
  config/       Config read/write and qcp paths
  db/           PostgreSQL connection layer
  llm/          Provider abstraction and streaming
  safety/       AST-based SQL validation
  schema/       Schema introspection and context building
  semantic/     Local semantic enrichment and MCP tools
  telemetry/    Privacy-safe product telemetry
  logger/       File logging and audit helpers
  output/       Terminal formatting
  types/        Shared TypeScript interfaces
apps/
  qcp-web/      Optional localhost web assistant
Formula/
  qcp.rb        Homebrew formula
scripts/
  install.sh    Shell installer
  install.ps1   Windows installer
```

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

Before opening a PR:

```bash
bun type-check
bun test
```

Keep these boundaries intact:

- SQL safety must remain AST-based.
- Database execution must remain read-only.
- Telemetry must never include SQL, row data, schema metadata, URLs,
  credentials, API keys, or tokens.

## Releasing

Maintainer releases are tag-driven:

```bash
git tag v0.3.2
git push origin v0.3.2
```

The release workflow builds binaries, creates a GitHub release, updates the
Homebrew formula, and publishes the package.

## License

[MIT](LICENSE) © Moduna AI
