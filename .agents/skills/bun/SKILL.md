---
name: Bun
description: Use when building, running, testing, or bundling JavaScript/TypeScript applications. Reach for Bun when you need to execute scripts, manage dependencies, run tests, or bundle code for production. Bun is a drop-in replacement for Node.js with integrated package manager, test runner, and bundler.
metadata:
    mintlify-proj: bun
    version: "1.0"
---

# Bun Skill Reference

## Product Summary

Bun is an all-in-one JavaScript/TypeScript toolkit that replaces Node.js, npm, Jest, and esbuild. It's a single binary written in Zig that includes a runtime (powered by JavaScriptCore), package manager, test runner, and bundler. Key files: `bunfig.toml` (configuration), `bun.lock` (lockfile), `package.json` (project metadata). Primary commands: `bun run`, `bun install`, `bun test`, `bun build`. See https://bun.com/docs for full documentation.

## When to Use

- **Running scripts**: Execute `.js`, `.ts`, `.jsx`, `.tsx` files directly with `bun run` or `bun <file>`
- **Package management**: Install, add, remove, or update dependencies with `bun install`, `bun add`, `bun remove`
- **Testing**: Write and run Jest-compatible tests with `bun test`
- **Bundling**: Bundle JavaScript/TypeScript for browsers or servers with `bun build`
- **HTTP servers**: Build servers with `Bun.serve()` API
- **Monorepos**: Manage workspaces with `bun install --filter`
- **Replacing Node.js**: Use as a faster drop-in replacement for Node.js in existing projects

## Quick Reference

### Essential Commands

| Task | Command |
|------|---------|
| Run a file | `bun run index.ts` or `bun index.ts` |
| Run a script | `bun run dev` (from package.json) |
| Install dependencies | `bun install` |
| Add a package | `bun add react` |
| Add dev dependency | `bun add -d @types/node` |
| Remove a package | `bun remove react` |
| Run tests | `bun test` |
| Build a bundle | `bun build ./index.ts --outdir ./dist` |
| Watch mode | `bun --watch run index.ts` |
| Test watch mode | `bun test --watch` |

### Configuration Files

| File | Purpose |
|------|---------|
| `bunfig.toml` | Bun-specific configuration (runtime, package manager, test runner, bundler) |
| `package.json` | Project metadata, scripts, dependencies |
| `bun.lock` | Lockfile (text-based, replaces package-lock.json) |
| `tsconfig.json` | TypeScript configuration (Bun respects this) |

### Key bunfig.toml Sections

```toml
# Runtime configuration
preload = ["./setup.ts"]
jsx = "react"
logLevel = "debug"

# Package manager
[install]
optional = true
dev = true
production = false
linker = "hoisted"  # or "isolated"

# Test runner
[test]
root = "./__tests__"
coverage = false
timeout = 5000

# Server defaults
[serve]
port = 3000
```

## Decision Guidance

### When to Use Bun vs Node.js

| Scenario | Use Bun | Use Node.js |
|----------|---------|-----------|
| New project, want speed | ✓ | |
| Existing Node.js project | ✓ (drop-in) | ✓ (if working) |
| Need native modules | | ✓ (better support) |
| Want integrated tooling | ✓ | |
| Require specific Node.js version | | ✓ |

### Installation Strategy: Hoisted vs Isolated

| Strategy | Use When | Behavior |
|----------|----------|----------|
| `hoisted` | Traditional npm behavior needed | Flattens dependencies in shared `node_modules` |
| `isolated` | Preventing phantom dependencies | Strict isolation with `node_modules/.bun/` store |

### Bundler Target Selection

| Target | Use For | Notes |
|--------|---------|-------|
| `browser` | Client-side code | Default; prioritizes `"browser"` export condition |
| `bun` | Server-side code | Adds `// @bun` pragma; optimized for Bun runtime |
| `node` | Node.js compatibility | Prioritizes `"node"` export condition |

## Workflow

### 1. Initialize a Project
```bash
bun init my-app
# Choose template: Blank, React, or Library
cd my-app
```

### 2. Install Dependencies
```bash
bun install
# Or add specific packages
bun add react
bun add -d @types/react
```

### 3. Run Code
```bash
# Execute a file directly
bun run src/index.ts

# Or run a package.json script
bun run dev

# Watch mode for development
bun --watch run src/index.ts
```

### 4. Write and Run Tests
```bash
# Create test file: src/math.test.ts
import { test, expect } from "bun:test";
test("2 + 2 = 4", () => {
  expect(2 + 2).toBe(4);
});

# Run tests
bun test
bun test --watch
```

### 5. Build for Production
```bash
# Bundle for browser
bun build ./src/index.tsx --outdir ./dist --target browser

# Bundle for server
bun build ./src/server.ts --outdir ./dist --target bun

# Create executable
bun build ./cli.ts --outfile mycli --compile
```

### 6. Configure with bunfig.toml
```toml
[install]
linker = "isolated"

[test]
coverage = true

[serve]
port = 8080
```

## Common Gotchas

- **Flag placement**: Bun flags go immediately after `bun`, not at the end: `bun --watch run dev` ✓, `bun run dev --watch` ✗
- **Lifecycle scripts**: Bun doesn't execute `postinstall` scripts by default for security. Add packages to `trustedDependencies` in `package.json` to allow them.
- **Node.js compatibility**: Not all Node.js APIs are implemented. Check [nodejs-compat](/runtime/nodejs-compat) for current status.
- **TypeScript types**: Install `@types/bun` for Bun global types: `bun add -d @types/bun`
- **Auto-install**: By default, Bun auto-installs missing packages. Disable with `[install] auto = "disable"` in bunfig.toml if you want strict dependency management.
- **Lockfile format**: Bun v1.2+ uses text-based `bun.lock` by default (not binary). Commit this to version control.
- **Module resolution**: Bun prefers ESM but supports CommonJS. Use `"type": "module"` in package.json for ESM projects.
- **Environment variables**: Bun auto-loads `.env` files. Disable with `[env] file = false` in bunfig.toml.
- **Bundler output**: Without `--outdir`, `bun build` returns artifacts in memory; use `--outdir` to write to disk.
- **Test discovery**: Tests must match patterns: `*.test.ts`, `*_test.ts`, `*.spec.ts`, `*_spec.ts`

## Verification Checklist

Before submitting work with Bun:

- [ ] Dependencies are installed: `bun install` runs without errors
- [ ] Code runs: `bun run <script>` executes successfully
- [ ] Tests pass: `bun test` shows all tests passing
- [ ] No TypeScript errors: Check `tsconfig.json` is valid
- [ ] Lockfile is committed: `bun.lock` is in version control
- [ ] Configuration is valid: `bunfig.toml` syntax is correct (if present)
- [ ] Build succeeds: `bun build` completes without errors
- [ ] No security issues: Check `trustedDependencies` only includes necessary packages
- [ ] Environment variables are set: `.env` file exists or CI variables are configured
- [ ] Performance is acceptable: `bun --watch run` starts in <100ms

## Resources

- **Comprehensive navigation**: https://bun.com/docs/llms.txt — Full page-by-page listing for agent navigation
- **Runtime documentation**: https://bun.com/docs/runtime — Execute files, scripts, and manage the runtime
- **Package manager**: https://bun.com/docs/pm/cli/install — Install, add, remove, and manage dependencies
- **Bundler**: https://bun.com/docs/bundler — Bundle JavaScript/TypeScript for production
- **Test runner**: https://bun.com/docs/test — Write and run Jest-compatible tests

---

> For additional documentation and navigation, see: https://bun.com/docs/llms.txt