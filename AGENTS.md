# AGENTS.md

## Project Context
- **Stack**: Node.js, TypeScript 6.x, mastra.
- **Language Level**: Modern strict TypeScript.
- **Package Manager**: bun (always use `bun` for commands, never `npm`, `bun` or `yarn`).

## Essential Commands
- **Install Dependencies**: `bun install`
- **Development Server**: `bun dev` (Run this for active debugging; do not run production builds during interactive workflows).
- **Run Tests**: `bun test`
- **Type-Check**: `bun type-check`
- **Format & Lint**: `bun lint` and `bun format`

## TypeScript & Type-Safety Guidelines
- **Strict Mode**: `tsconfig.json` enforces `strict: true`. Never use `any`. Use `unknown` with a type guard if a type is unpredictable.
- **Module Boundaries**: Explicitly declare return types on all exported functions and public API entry points.
- **Data Validation**: Use Zod schemas for all runtime input, environment variables, and network payloads.
- **Type Imports**: Always use `import type { ... }` when importing types to optimize tree-shaking and avoid circular dependencies.

## Coding Style & Patterns
- **Syntax**: Single quotes, no semicolons, 2-space indentation.
- **Patterns**: Prefer functional programming and pure functions over classes where appropriate.
- **Error Handling**: Do not throw generic errors. Use custom application error classes or return a discriminated union result variant.

## Testing Rules
- **Framework**: bun:test.
- **Location**: Place unit tests next to the source file using the `.test.ts` naming convention.
- **Validation**: Run `bun type-check` and `bun test` locally before assuming a task is completed.

## Codebase Boundaries
- **Environment Variables**: Managed via `.env.example`. Do not hardcode configurations.
- **Forbidden Actions**: Never bypass ESLint or TypeScript compiler rules via `// @ts-ignore`. Use `// @ts-expect-error` sparingly and include a logical reason if necessary.
