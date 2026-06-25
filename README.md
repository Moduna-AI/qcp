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

Most data questions never get answered because they require SQL knowledge or data team availability. qcp bridges that gap — letting any developer or analyst query their PostgreSQL database using plain English, with full transparency into the generated SQL and a safety model that makes it impossible to accidentally modify data.

**Three principles:**
1. **Safety** — Read-only enforcement at the AST level. No string matching. Impossible to run INSERT, UPDATE, DELETE, or any write operation.
2. **Trust** — Every generated SQL query is shown before execution. You always know what ran against your database.
3. **Privacy** — No row data, schema metadata, SQL queries, or credentials are ever sent to telemetry. Your data stays yours.

---

## Installation

### Homebrew (macOS/Linux)

```bash
brew tap Moduna-AI/qcp https://github.com/Moduna-AI/qcp
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

---

## Quick Start

```bash
# 1. Set up your AI provider (Gemini is the default — free tier available)
qcp auth

# 2. Connect to your PostgreSQL database
qcp connect postgres://readonly_user:password@localhost:5432/mydb

# 3. Index your schema (runs locally — no data leaves your machine)
qcp schema scan

# 4. Ask a question
qcp ask "Which products have the lowest inventory?"

# 5. Or start an interactive session
qcp chat
```

---

## Commands

### Core

| Command | Description |
|---|---|
| `qcp auth` | Interactive wizard to configure your AI provider |
| `qcp init` | Initialize qcp config and local project files |
| `qcp connect <url>` | Connect to a PostgreSQL database |
| `qcp schema scan` | Index the database schema locally |
| `qcp ask "<question>"` | Query your database in plain English |
| `qcp chat` | Start interactive multi-question session |
| `qcp explain "<question>"` | Generate SQL without executing it |
| `qcp doctor` | Run system diagnostics |

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

---

## Supported Providers

| Provider | Default Model | API Key |
|---|---|---|
| **Gemini** (default) | `gemini-2.5-flash` | [Google AI Studio](https://aistudio.google.com/app/apikey) |
| **OpenAI** | `gpt-4o` | [OpenAI Platform](https://platform.openai.com/api-keys) |
| **Anthropic** | `claude-opus-4-5` | [Anthropic Console](https://console.anthropic.com) |
| **Ollama** | `qwen3` | No key needed (local) |

---

## Safety Model

qcp enforces read-only access at **two independent layers**:

### 1. SQL Safety (AST-based)

Every generated SQL is parsed into an Abstract Syntax Tree and validated before execution. This is **not string matching** — it's a structural parse of the SQL.

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

### 2. Transaction-level enforcement

All queries run inside a `BEGIN READ ONLY` transaction. Even if the safety parser were somehow bypassed, the database itself would reject any write operation.

### 3. Human-in-the-loop approval

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

---

## Privacy Model

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

`qcp schema scan` reads **structure only** — table names, column names, types, and relationships. It never reads row data. The schema is stored locally in `.qcp/schema.json` and never sent to any external service.

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
  cli/          CLI entry point (Commander.js)
  commands/     One file per command
  config/       Config read/write + paths
  db/           PostgreSQL connection (postgres.js)
  llm/          LLM provider abstraction + streaming
  safety/       AST-based SQL validation
  schema/       Schema introspection + context builder
  telemetry/    PostHog (privacy-safe)
  logger/       Winston file logger
  output/       Terminal formatting (chalk, cli-table3)
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
