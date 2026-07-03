# Security Policy

qcp is designed to make AI-assisted database querying safer, but it should still be treated as software that sits next to valuable data. This document explains the security model, privacy expectations, recommended deployment posture, and how to report vulnerabilities.

## Supported Versions

Security fixes are applied to the latest published qcp release and the `main` branch. If you are using an older version, upgrade before reporting behavior that may already have been fixed.

## Security Model

qcp treats all LLM output as untrusted. The model can propose SQL, but deterministic TypeScript code decides whether that SQL can run.

### Read-only enforcement

qcp enforces read-only behavior in multiple layers:

- SQL is parsed with `pgsql-ast-parser` and validated structurally before execution.
- Only `SELECT`, safe `WITH`, and `EXPLAIN` statements are allowed.
- Data-changing statements such as `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `CREATE`, `GRANT`, `REVOKE`, and `COPY` are rejected.
- Multiple statements are rejected.
- Data-changing CTEs are rejected, even when hidden inside a top-level `WITH`.
- Database reads run inside PostgreSQL read-only transactions.

This validation is deterministic and does not rely on the LLM following instructions.

### Tenant isolation for Mastra tools

For Prisma/Mastra database tools, qcp requires trusted server-side identity context:

- `requestContext.tenantId`
- `requestContext.userId`

The agent is never trusted to invent tenant filters. qcp injects tenant and user predicates into supported SQL using AST rewriting, then executes only the rewritten SQL.

Default scope-column mapping:

- `tenantId`: `organization_id`, `tenant_id`, `org_id`, `workspace_id`, `account_id`
- `userId`: `user_id`, `owner_id`

Queries fail closed when qcp cannot determine a safe scope. This includes unknown tables, ambiguous unqualified tables, tables without supported scope columns, unsafe outer joins, table functions, lateral queries, and unsupported nested-query shapes.

### Human approval

qcp has human-in-the-loop approval for sensitive or potentially expensive reads:

- CLI `safeMode` prompts before queries that match sensitive table patterns or estimated high-cost scans.
- Mastra execution tools use tool-level approval hooks for sensitive or high-cost reads.

`--yes` skips CLI approval prompts only. It does not disable SQL validation, read-only transactions, tenant isolation, or scrubbing.

### Output scrubbing

Database tool outputs are scrubbed before they are returned to model-facing contexts. qcp masks common sensitive values including:

- Email addresses
- Phone numbers
- SSNs
- Bearer tokens and JWT-like tokens
- API keys, secrets, passwords, and long secret-like strings

Scrubbing is a defense-in-depth layer. Do not use it as the only control for highly sensitive data; prefer least-privilege database roles, views, row-level security, and tenant-scoped credentials.

### Error hygiene

Raw database errors are not returned to the agent unchanged. qcp suppresses stack traces, raw SQL, and schema-revealing database messages in model-facing tool responses.

### Semantic layer

The semantic layer is local-first and advisory:

- Structural schema remains stored in `~/.qcp/schemas.json`.
- Human-authored semantic annotations are stored in `~/.qcp/semantic.db`.
- `qcp semantic scan` is structure-only and does not read row values.
- `qcp semantic profile` is opt-in per selected table/column, uses bounded read-only queries, skips sensitive-pattern columns by default, truncates stored values, and stores local summaries only.
- Semantic context can help agents map business language to schema objects, but SQL validation and execution still use the full structural schema and the read-only safety pipeline.

## Privacy Model

### LLM provider data flow

To generate SQL and summaries, qcp sends data to the configured model provider. Depending on the command and provider, this may include:

- Your natural-language question
- Locally scanned schema context
- Relevant local semantic annotations, when configured
- Generated SQL
- Query results for summarization

Use Ollama or another local model provider if you do not want database context or result summaries sent to a hosted LLM provider.

### Telemetry data flow

Anonymous telemetry is separate from LLM provider calls. qcp telemetry does not include:

- SQL queries
- Query results
- Schema metadata
- Semantic annotations or value profiles
- Database URLs
- Credentials
- API keys or tokens
- Row data

Telemetry may include qcp version, OS/architecture, command names, model/provider names, latency, and coarse error categories.

Disable telemetry:

```bash
qcp telemetry off
```

## Recommended Deployment Posture

Use defense in depth:

- Connect qcp with a database role that has read-only permissions.
- Prefer database views that expose only fields safe for analysis.
- Enable PostgreSQL row-level security for multi-tenant applications.
- Avoid granting access to secrets, credentials, raw tokens, payment data, or health data unless explicitly needed.
- Keep `safeMode` enabled for interactive use.
- Treat `--yes` as an automation-only option for trusted environments.
- Review `~/.qcp/schemas.json`, `~/.qcp/semantic.db`, logs, and support bundles before sharing them.
- Rotate credentials if they may have been exposed in terminal output, shell history, or logs.

## Known Limits

qcp reduces risk; it does not make arbitrary database access risk-free.

- Schema context and result summaries can be sent to the configured LLM provider.
- Semantic annotations can be sent to the configured LLM provider when relevant to an ask/chat request.
- Opt-in semantic value profiles are local summaries, but they may still reveal business-sensitive value names.
- PII scrubbing is pattern-based and may not catch every sensitive value.
- Tenant isolation currently supports conservative SQL shapes and rejects unsupported forms.
- Database permissions remain the strongest boundary. Use least-privilege credentials.
- If you disable safe mode or use `--yes`, you remove interactive approval, not deterministic validation.

## Reporting Vulnerabilities

Please report security issues privately. Do not open a public GitHub issue for vulnerabilities.

Email: security@moduna.ai

Include:

- qcp version
- Installation method
- Operating system
- Database type/provider, if relevant
- A minimal reproduction
- Whether credentials, SQL text, schema details, or row data were exposed

We will acknowledge reports as soon as possible and coordinate a fix before public disclosure.

## Security Test Coverage

The repository includes tests for:

- Destructive SQL rejection
- Multi-statement rejection
- Data-changing CTE rejection
- Tenant/user predicate injection
- Cross-tenant query rejection
- Unknown and unscoped table rejection
- PII/token scrubbing
- Sanitized database errors
- Mastra request-context enforcement
- Sensitive/high-cost approval hooks

Run locally:

```bash
bun test
bun type-check
bun lint
```
