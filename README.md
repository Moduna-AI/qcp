<div align="center">

# ◆ qcp — Query Companion

**AI-powered natural language interface for PostgreSQL**

[![npm stable version](https://img.shields.io/npm/v/%40moduna/qcp?color=blue&label=npm%20stable)](https://www.npmjs.com/package/@moduna/qcp)
[![npm beta version](https://img.shields.io/npm/v/%40moduna/qcp/next?color=orange&label=npm%20beta)](https://www.npmjs.com/package/@moduna/qcp/v/next)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![CI](https://github.com/Moduna-AI/qcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Moduna-AI/qcp/actions)

Ask questions about your PostgreSQL database in plain English. Get safe, read-only SQL, results, and natural language summaries — all in your terminal.

```
$ qcp ask "What were our top customers last month?"

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
  Acme Corporation led last month with $125,432 in revenue, followed closely
  by TechCorp Inc at $98,765. Together they represent the top tier of customers.
```

</div>

---

## Why qcp?

Most data questions never get answered because they require SQL knowledge or data team availability. qcp bridges that gap — letting any developer or analyst query their PostgreSQL database using plain English, with full transparency into the generated SQL and deterministic guardrails around database access.

**Three principles:**
1. **Safety** — Read-only enforcement at the AST level plus read-only database transactions. `INSERT`, `UPDATE`, `DELETE`, DDL, and privilege changes are rejected before execution.
2. **Trust** — Every generated SQL query is shown before execution. You always know what qcp intends to run against your database.
3. **Privacy** — Telemetry never includes SQL, schema metadata, row data, connection URLs, or credentials. Database tool outputs are scrubbed before they are returned to an agent context.

---

## Installation

### Homebrew (macOS/Linux)

```bash
brew tap moduna-ai/qcp
brew install qcp
```

### curl (macOS/Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/Moduna-AI/qcp/main/scripts/install.sh | sh
```

### PowerShell (Windows)

```powershell
irm https://raw.githubusercontent.com/Moduna-AI/qcp/main/scripts/install.ps1 | iex
```

### npm / pnpm / bun

```bash
npm install -g qcp
pnpm add -g qcp
bun add -g qcp
```

### Optional local web assistant

`qcp-web` is a separate opt-in localhost app. It is not installed by the
standard `qcp` CLI installers.

From this repository:

```bash
bun install
bun run build
cd apps/qcp-web
bun run dev
```

Or run the app launcher with Bun:

```bash
cd apps/qcp-web
bun run ./bin/qcp-web.ts
```

On first launch, open the localhost app and choose a local qcp-web passcode.
qcp stores only a hash in `~/.qcp/config.json`. It reads the same `qcp connect`
aliases, model provider, API keys, and schema catalog as the CLI. If a selected
database has no schema, run:

```bash
qcp schema scan
```

---

## Quick Start

```bash
# 1. Set up your AI provider (Gemini is the default — free tier available)
qcp auth

# 2. Connect to your PostgreSQL database (guided database selector)
qcp connect

# 3. Index your schema (runs locally — no data leaves your machine)
qcp schema scan

# 4. Optional: add business meaning for tables/columns
qcp semantic scan
qcp semantic enrich

# 5. Ask a question
qcp ask "Which products have the lowest inventory?"

# 6. Or start an interactive session
qcp chat
```

---

## Commands

### Core

| Command | Description |
|---|---|
| `qcp auth` | Guided wizard to configure Gemini, OpenAI, Anthropic, or Ollama |
| `qcp init` | Initialize qcp config and local project files |
| `qcp connect` | Add or replace a named database connection |
| `qcp db list` | List configured database connections |
| `qcp db current` | Show the active database connection |
| `qcp db use <alias>` | Switch the active database connection |
| `qcp db edit <alias>` | Modify a connection and refresh its schema |
| `qcp db remove <alias>` | Remove a connection and its cached schema |
| `qcp schema scan` | Index the database schema locally |
| `qcp semantic scan` | Sync schema objects into the local semantic store |
| `qcp semantic status` | Show semantic enrichment coverage and stale objects |
| `qcp semantic enrich` | Interactively annotate tables and columns |
| `qcp semantic profile <table>` | Opt in to bounded value profiling for selected columns |
| `qcp semantic mcp` | Start the qcp semantic MCP server over stdio |
| `qcp ask "<question>"` | Query your database in plain English |
| `qcp chat` | Start interactive multi-question session |
| `qcp explain "<question>"` | Generate SQL without executing it |
| `qcp doctor` | Run system diagnostics |

### SDK Usage

qcp also ships an ESM SDK for embedding the assistant in another Node.js or Bun project:

```ts
import { createQcpClient } from "@moduna/qcp";

const qcp = createQcpClient();
const answer = await qcp.ask("What tables do you know?");

console.log(answer.text);
```

The SDK uses the same local qcp config, active connection, cached schema, runtime package store, and read-only guardrails as the CLI. Importing `@moduna/qcp` has no CLI side effects. Runtime package installation is explicit; pass `installMissingPackages: true` or call `installQcpSdkRuntimePackages()` when an embedding app wants qcp to install missing provider/runtime packages.

Curated subpath exports are available for lower-level integrations:

```ts
import type { DatabaseSchema } from "@moduna/qcp/types";
import { validateSql } from "@moduna/qcp/safety";
import { scanSchema } from "@moduna/qcp/schema";
import { executeQuery } from "@moduna/qcp/db";
import { listPackageGroupStatuses } from "@moduna/qcp/runtime";
```

### Model Management

```bash
qcp model list                  # List all providers and models
qcp model set gemini            # Switch to Gemini (default)
qcp model set gemini-2.5-pro    # Use a specific model
qcp model set openai            # Switch to OpenAI
qcp model set gpt-4o-mini
qcp model set anthropic         # Switch to Anthropic
qcp model set ollama            # Local models via Ollama
```

### Configuration

```bash
qcp config show                 # View current settings
qcp config set safeMode true    # Require approval for sensitive queries
qcp config set showSql false    # Hide generated SQL
qcp config set showMetrics true # Always show token/timing metrics
qcp config set-key gemini AIza... # Save API key
```

### Non-Interactive Setup

```bash
qcp config set-key gemini YOUR_API_KEY
qcp connect --name prod --type neon postgres://readonly_user:password@host/db
qcp connect --name prod --type prisma-postgres --schema prisma/schema.prisma --datasource db postgres://readonly_user:password@host/db
qcp db edit prod --name production
qcp db edit production --type neon postgres://readonly_user:password@host/db
qcp db remove production --yes
```

Database connections are stored in `~/.qcp/config.json`; structural schema indexes are stored in `~/.qcp/schemas.json`; semantic enrichment is stored locally in `~/.qcp/semantic.db`. Successful `connect` and `db edit` runs test the final connection URL and refresh the schema index. Removing a database also removes its cached schema entry.

### Semantic Layer

```bash
qcp semantic scan                 # Sync structural objects into ~/.qcp/semantic.db
qcp semantic status               # Show enrichment coverage and stale objects
qcp semantic enrich               # Annotate missing tables/columns interactively
qcp semantic enrich --table users # Limit enrichment to one table
qcp semantic enrich --force       # Add a new annotation version
qcp semantic profile users --column status
qcp semantic mcp                  # Expose semantic tools over Mastra MCP stdio
```

The semantic layer stores human-authored descriptions, business names, synonyms, relationship notes, and optional value profiles. `qcp ask` and `qcp chat` use this context when available, but SQL validation and execution still run against the full structural schema.

Normal semantic scans are structure-only. Value-level context is opt-in through `qcp semantic profile`; profiling uses bounded read-only queries, skips sensitive-pattern columns by default, truncates stored values, and stores only local summaries.

### Diagnostics

```bash
qcp doctor                      # Human-readable health report
qcp doctor --json               # Machine-readable JSON output
qcp doctor --bundle             # Create support bundle (no credentials)
```

### ask options

```bash
qcp ask "question" --metrics    # Show token counts and latency
qcp ask "question" --verbose    # Show generation details
qcp ask "question" --debug      # Show raw LLM output and EXPLAIN plan
qcp ask "question" --yes        # Skip approval prompts
```

Use `--yes` only in trusted local workflows. It skips human approval prompts, but it does not disable SQL validation, read-only transactions, tenant isolation, or result scrubbing.

---

## Supported Providers

| Provider | Default Model | API Key |
|---|---|---|
| **Gemini** (default) | `gemini-3.5-flash` | [Google AI Studio](https://aistudio.google.com/app/apikey) |
| **OpenAI** | `gpt-5.5` | [OpenAI Platform](https://platform.openai.com/api-keys) |
| **Anthropic** | `claude-opus-4-8` | [Anthropic Console](https://console.anthropic.com) |
| **Ollama** | `qwen3` | No key needed (local) |

---

## Safety and Security Model

qcp treats LLM output as untrusted. The model can suggest SQL, but deterministic code decides whether that SQL is allowed to run.

### 1. SQL Safety (AST-Based)

Every generated SQL statement is parsed into an Abstract Syntax Tree and validated before execution. The allowlist is structural, not prompt-based.

**Allowed:** `SELECT`, `WITH` (CTEs), `EXPLAIN`

**Rejected:** `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `CREATE`, `GRANT`, `REVOKE`, `COPY`

```bash
# What happens with a dangerous query
$ qcp ask "delete all users"

Safety:
  ✗ SELECT-only query
  ✗ Dangerous operation rejected: DELETE is not permitted.
     qcp is read-only and only allows SELECT, WITH, and EXPLAIN.

✗ Query rejected — does not meet safety requirements.
```

`WITH` queries are also inspected internally, so a data-changing CTE such as `WITH deleted AS (DELETE ...) SELECT ...` is rejected.

### 2. Transaction-level enforcement

All database reads run inside a `BEGIN READ ONLY` transaction. Even if application-level validation were bypassed, PostgreSQL should reject write operations inside the transaction.

### 3. Mastra Tool Containment

The Prisma/Mastra database tools route execution through one security pipeline:

1. Validate read-only SQL.
2. Require trusted Mastra `requestContext.tenantId` and `requestContext.userId`.
3. Inject tenant/user predicates into supported `SELECT`/`WITH` queries.
4. Execute only the rewritten SQL.
5. Scrub sensitive output before it reaches the LLM/tool transcript.
6. Return sanitized errors without raw stack traces or schema dumps.

Direct `qcp ask` execution does not invent a tenant boundary. If the Prisma tool path has no trusted Mastra request context, query execution fails closed instead of relying on the LLM to add tenant filters.

### 4. Tenant Isolation

For Mastra database tool execution, qcp deterministically scopes queries using schema metadata:

- `tenantId` maps to `organization_id`, `tenant_id`, `org_id`, `workspace_id`, or `account_id`.
- `userId` maps to `user_id` or `owner_id`.
- Tables without a supported scope column are rejected.
- Unknown tables, ambiguous unqualified tables, unsafe outer joins, table functions, lateral queries, and unsupported nested-query shapes are rejected.

Tenant predicates are injected by AST rewriting and serialization, not by string concatenation and not by LLM instructions.

### 5. Privacy Scrubbing

Database tool outputs are recursively scrubbed before they are returned to an agent/model-facing context. qcp masks common sensitive values including:

- Email addresses
- Phone numbers
- SSNs
- Bearer tokens and JWT-like tokens
- API keys, secrets, passwords, and long secret-like strings

### 6. Human-in-the-loop approval

When `safeMode` is enabled (default), qcp prompts for confirmation before executing queries that:
- Access potentially sensitive tables (`users`, `customers`, `payments`, etc.)
- Scan an estimated large number of rows

```bash
⚠  Potentially sensitive query detected
   Reasons:
   • Query accesses potentially sensitive tables: customers
   • Estimated 5,200,000 rows scanned

? Execute this query? (y/N)
```

Mastra execution tools also use tool-level approval hooks for sensitive or high-cost reads.

### 7. Error Hygiene

Raw database errors are not returned to the agent as-is. qcp suppresses driver stack traces, raw SQL, and schema-revealing database messages in model-facing tool responses.

For more detail, see [SECURITY.md](SECURITY.md).

---

## Privacy Model

qcp has two different data flows:

1. **LLM provider flow** — To generate SQL and summaries, qcp sends your question, local structural schema context, and any relevant local semantic annotations to your configured provider unless you use a local provider such as Ollama. Query results may be sent to the configured provider for summarization.
2. **Telemetry flow** — Anonymous product telemetry is separate and intentionally excludes database content.

### What qcp sends to telemetry (PostHog)

- qcp version
- Operating system and CPU architecture
- Which commands you run
- Error event types (not error content)

### What qcp NEVER sends

- SQL queries or query results
- Database connection URLs or credentials
- Schema metadata (table/column names)
- API keys or tokens
- Any row data from your database

Disable telemetry at any time:
```bash
qcp telemetry off
```

### Schema scanning

`qcp schema scan` reads **structure only** — table names, column names, types, and relationships. It never reads row data. The schema catalog is stored locally in `~/.qcp/schemas.json`.

`qcp semantic scan` also remains structure-only. Human annotations are stored in `~/.qcp/semantic.db`. `qcp semantic profile` is the only semantic command that reads values, and it must be invoked for selected tables/columns; it skips sensitive-pattern columns by default and stores truncated local summaries.

When you ask questions with a hosted LLM provider, qcp may send relevant structural schema context and relevant semantic annotations to that configured provider so it can generate SQL.

### Logs and support bundles

qcp logging and support tooling are designed to avoid credentials, SQL text, schema content, and row data. If you share logs or support bundles publicly, review them first as you would with any developer diagnostic artifact.

---

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
  "sensitiveTablePatterns": ["user", "customer", "payment", "billing"]
}
```

### Environment variables

```bash
QCP_DATABASE_URL=postgres://...   # Database connection URL
GEMINI_API_KEY=AIza...            # Gemini API key
OPENAI_API_KEY=sk-...             # OpenAI API key
ANTHROPIC_API_KEY=sk-ant-...      # Anthropic API key
OLLAMA_HOST=http://localhost:11434 # Ollama server URL
```

---

## Local Development

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.1.0
- Node.js ≥ 18 (for npm distribution)
- A PostgreSQL database for testing

```bash
# Clone
git clone https://github.com/Moduna-AI/qcp
cd qcp

# Install dependencies
bun install

# Run in dev mode
bun run dev -- ask "show me all tables"

# Run tests
bun test

# Build Node.js bundle
bun run build

# Build self-contained binary
bun run build:binary

# Type check
bun run lint
```

### Project Structure

```
src/
  index.ts      SDK entry point
  sdk.ts        High-level importable SDK client
  cli/          CLI entry point (Commander.js)
  commands/     One file per command
  config/       Config read/write + paths
  db/           PostgreSQL connection (postgres.js)
  llm/          LLM provider abstraction + streaming
  safety/       AST-based SQL validation
  schema/       Schema introspection + context builder
  semantic/     Local semantic schema enrichment, retrieval, profiling, MCP tools
  telemetry/    PostHog (privacy-safe)
  logger/       Winston file logger
  output/       Terminal formatting (chalk, cli-table3)
  runtime.ts    Runtime package helpers exported for SDK users
  types/        TypeScript interfaces
tests/
  safety.test.ts    SQL safety validation tests
  schema.test.ts    Schema context tests
Formula/
  qcp.rb            Homebrew formula
scripts/
  install.sh        curl installer (Linux/macOS)
  install.ps1       PowerShell installer (Windows)
.github/workflows/
  ci.yml            Test + build on push/PR
  release.yml       Binary build + GitHub Release + npm publish
```

---

## Local Homebrew Testing

To test the Homebrew formula before publishing a release:

```bash
# Build binary
make build-binary

# Tap from local path
brew tap Moduna-AI/qcp "$(pwd)"

# Install HEAD (builds from source)
brew install --HEAD Moduna-AI/qcp/qcp

# Verify
qcp --version
```

---

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

**Key guidelines:**
- Safety is non-negotiable. The SQL safety module must remain AST-based.
- No write operations can ever be executed under any circumstances.
- No sensitive data (SQL, DB URLs, schema, API keys) in telemetry.
- All PRs must pass `bun test` and `bun run lint`.

```bash
# Run all checks before submitting a PR
bun test
bun run lint
```

---

## Releasing (maintainers)

```bash
# Create and push a version tag
git tag v0.1.1
git push origin v0.1.1
```

This triggers the release workflow which:
1. Builds binaries for all 5 platforms
2. Creates a GitHub Release with artifacts and checksums
3. Updates the Homebrew formula SHA256 automatically
4. Publishes to npm

---

## License

[MIT](LICENSE) © Moduna AI
