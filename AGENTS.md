# Project Guidelines

## Overview
- pbtsdb is a TypeScript library that integrates PocketBase (backend-as-a-service) with TanStack's reactive database and query management tools. It provides type-safe collection management with real-time data synchronization capabilities.


## Code Style & Patterns
- Run quality checks after any changes:
   - `npm run lint` (Biome lint + format check)
   - `npm run typecheck`
   - `npm run test` (will start test server and run tests against it)
- Embrace Type Inference: Do not over-specify types, allow TypeScript to infer types whenever possible.
  - DO NOT USE `any` to pass type checks, even with biome ignore comments.
- Keep comments to a minimum, they should ONLY be used to convey critical context.  Well written code should speak for itself and not require comments.
- Document public API methods with jsdoc comments
- Biome enforces 4-space indentation, single quotes, ES5 trailing commas, and no superfluous semicolons.

## Data Queries & Mutations
- Reference documentation:
   - PocketBase: https://raw.githubusercontent.com/Suryapratap-R/pocketbase-llm-txt/refs/heads/main/llms-full.txt
   - TanStack DB: https://tanstack.com/db/latest/docs/overview

## Logging
- Use the centralized logger from `src/logger.ts` instead of console.log
- Import with: `import { logger } from './logger'`
- Available log levels: `logger.debug()`, `logger.info()`, `logger.warn()`, `logger.error()`
- Use `logger.debug()` for verbose development info, `logger.info()` for general information, `logger.warn()` for warnings, and `logger.error()` for errors

## Scripts Reference
- npm run lint        # Check for linting issues
- npm run lint:fix    # Auto-fix linting issues
- npm run typecheck   # TypeScript type checking
- npm run checks      # Run both typecheck and lint

## Testing Expectations
- Unit tests belong in `test` directory
  - a single test can be ran with: `TEST=<test file> npm run test`
- New features should ship with unit coverage and pass all type and lint checks.
- Record flaky tests in the PR and gate merges on a green rerun.

## PocketBase Notes
- Local testing data lives in `pb_data/`; reset via `npm run db:reset` when fixtures fall out of sync.

