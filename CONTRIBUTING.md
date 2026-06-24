# Contributing to qcp

Thank you for your interest in contributing to qcp!

## Getting Started

```bash
git clone https://github.com/Moduna-AI/qcp
cd qcp
bun install
bun test
bun run dev -- --help
```

## Project Principles (non-negotiable)

1. **Safety first.** The SQL safety layer must remain AST-based. No string matching. No exceptions to the read-only model.
2. **Trust.** Users must always see the SQL that will be executed.
3. **Privacy.** No SQL, DB URLs, schema data, or API keys may appear in telemetry or logs.

## Development Workflow

```bash
# Run tests
bun test

# Type check
bun run lint

# Run with a real database
QCP_DATABASE_URL=postgres://... bun run dev -- ask "show tables"

# Build binary
bun run build:binary
./dist/qcp --version
```

## Pull Request Checklist

- [ ] `bun test` passes
- [ ] `bun run lint` (tsc --noEmit) passes
- [ ] No sensitive data in telemetry
- [ ] Safety tests updated if safety logic changed
- [ ] README updated if new commands/options added

## Reporting Issues

Please use [GitHub Issues](https://github.com/Moduna-AI/qcp/issues).

For bug reports, attach a `qcp doctor --bundle` output (it's pre-redacted of all credentials).

## License

By contributing, you agree your contributions will be licensed under the MIT License.
