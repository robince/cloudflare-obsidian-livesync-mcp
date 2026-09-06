# Repository Guidelines

## Project Structure & Module Organization

This npm workspace provides a CouchDB-compatible Cloudflare Worker backed by PouchDB in SQLite Durable Objects, plus an optional MCP Worker.

- `src/`: storage Worker, HTTP protocol, authentication, and Durable Object implementation; `livesync-vault/` handles logical vault operations, and `backup/` handles R2 backups.
- `apps/cloudflare-obsidian-mcp/`: MCP Worker source, OAuth integration, configuration, and tests.
- `packages/livesync-contracts/`: shared storage/MCP contracts.
- `test/`: storage integration tests, fixtures, and script tests.
- `scripts/`: backup, diagnostics, dependency checks, and staging utilities.
- `docs/`, `COMPATIBILITY.md`, and `DEPLOY.md`: architecture constraints, operational procedures, and deployment guidance.

## Build, Test, and Development Commands

Use Node.js `^22.18.0 || >=24.11.0` and the root npm lockfile.

- `npm ci`: install workspace dependencies and apply the Commonlib patch automatically.
- `npx wrangler dev`: run the storage Worker locally; first copy `.dev.vars.example` to `.dev.vars` and configure credentials.
- `npm run types`: regenerate Worker binding declarations after configuration changes.
- `npm run types:check`: verify generated declarations are current.
- `npm run check`: check production dependencies and TypeScript across workspaces.
- `npm test`: run the primary storage and integration suites.
- `npm run test:all`: include workspace, staging-configuration, and diagnostics tests.
- `npm run dry-run`: bundle both Workers without deploying.

## Coding Style & Naming Conventions

Follow existing TypeScript: strict typing, ES modules, two-space indentation, single quotes, and semicolons. Use kebab-case filenames, camelCase functions and variables, and PascalCase types and classes. Keep shared RPC contracts in `packages/livesync-contracts`. No dedicated formatter or linter is configured; match surrounding code and run TypeScript checks.

## Testing Guidelines

Use Vitest with the Cloudflare plugin for workerd integration tests and Node's test runner for `.test.mjs` scripts. Name tests `*.test.ts` or `*.test.mjs` in the relevant `test/` directory. Add regression coverage for changed protocol, revision/conflict, authentication, and backup behavior. No numeric coverage threshold is configured. Before submitting, run the CI checks: `types:check`, `check`, `test:all`, and `dry-run`.

## Commit & Pull Request Guidelines

History generally uses short imperative subjects such as “Add single-vault R2 backups”; Conventional Commit prefixes appear occasionally but are not mandatory. Keep commits focused. PRs should explain the behavior change, relevant issues, validation performed, and configuration or compatibility implications. Update operational documentation when procedures change.

## Security & Configuration

Keep credentials in ignored `.dev.vars` files or Worker secrets. Never commit passwords or local `wrangler.deploy.jsonc` files. Use `DEPLOY.md` for deployment: `npm run deploy` publishes both Workers.
