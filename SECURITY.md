# Security Policy

## Supported Versions

Security updates are provided for the latest version of this project. Older versions may not receive fixes.

| Version | Supported |
|---------|-----------|
| Latest | ✅ |
| Older releases | ❌ |

---

# Reporting a Vulnerability

If you believe you have discovered a security vulnerability, please **do not open a public GitHub issue**.

Instead:

- Open a private GitHub Security Advisory, if enabled.
- Or contact the maintainer directly with:
  - A description of the issue
  - Steps to reproduce
  - A proof-of-concept (if available)
  - The potential impact

We will acknowledge reports as quickly as possible and work toward a fix before public disclosure.

---

# Security Model

This project is designed to safely validate **read-only PostgreSQL SQL** before execution.

The validator is intended to reduce the risk of executing unsafe SQL supplied by users or AI systems.

## Allowed Statements

Only the following statement types are permitted:

- `SELECT`
- `WITH`
- `EXPLAIN` (validated recursively)

All other statement types are rejected.

---

# Security Controls

Validation is performed using multiple independent layers:

1. Query length limits to reduce parser abuse and denial-of-service risk.
2. Detection of known dangerous PostgreSQL functions (for example `pg_read_file`, `dblink`, and large-object file operations).
3. Fast rejection of dangerous first-keyword statements such as `INSERT`, `UPDATE`, `DELETE`, `DROP`, and `ALTER`.
4. Recursive validation of `EXPLAIN` statements.
5. AST-based parsing using `pgsql-ast-parser`.
6. Single-statement enforcement.
7. Statement allow-list (`SELECT` and `WITH` only).
8. Automatic `LIMIT` injection or clamping to reduce accidental large result sets.

The validator follows a **fail-safe** design:

- SQL that cannot be parsed is rejected.
- Unknown statement types are rejected.
- Multiple SQL statements are rejected.
- Only explicitly permitted statements are allowed.

---

# Security Guarantees

The validator is designed to provide the following protections:

- Prevent execution of data modification statements.
- Prevent execution of schema modification statements.
- Prevent multiple SQL statement execution.
- Reduce the risk of dangerous PostgreSQL built-in functions.
- Bound result-set sizes through automatic `LIMIT` enforcement.
- Reject malformed SQL rather than attempting recovery.

---

# Limitations

No SQL validator can guarantee complete security by itself.

This project should be used as one layer in a defense-in-depth architecture alongside:

- Read-only database roles
- Least-privilege database permissions
- Network isolation
- Connection-level security
- Query timeouts
- Statement execution time limits
- Row-level security where appropriate
- Audit logging

Text-based detection of dangerous functions and sensitive tables is intentionally conservative and should not be considered a substitute for database permissions.

---

# Recommended Deployment

For production deployments:

- Use a dedicated read-only PostgreSQL role.
- Disable unnecessary extensions.
- Set reasonable statement timeouts.
- Restrict network access to the database.
- Enable logging and monitoring.
- Keep dependencies up to date.

Even if this validator fails, the database should still prevent destructive operations through privilege separation.

---

# Scope

This project validates SQL before execution. It does **not** provide:

- SQL injection protection for application code
- Authentication
- Authorization
- Database sandboxing
- Protection against misconfigured database permissions

Those controls remain the responsibility of the surrounding application and infrastructure.

---

# Responsible Disclosure

We appreciate responsible disclosure of security issues. Please allow time for investigation and remediation before publicly disclosing newly discovered vulnerabilities.