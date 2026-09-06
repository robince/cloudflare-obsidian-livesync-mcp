# Development and architecture

The sync server provides a CouchDB-compatible endpoint backed by PouchDB in a
SQLite Durable Object. Each database name maps to one Durable Object, isolating
its data and serialising its writes. The optional MCP Worker accesses the same
storage through a private Worker binding.

## Current status

Both the sync server and optional MCP Worker are implemented and working.
Remote staging with real Obsidian clients has verified syncing, GitHub OAuth,
MCP note changes propagating between devices, and conflict handling. See the
[staging results](conflict-staging-results.md) for the tested versions and cases.

The sync server passes workerd integration tests for:

- database creation, information, and deletion;
- document CRUD, local checkpoint documents, attachments, `_bulk_docs`, and
  `_all_docs`;
- `_changes` normal, selector-filtered, long-poll, and LiveSync's bounded
  newline-delimited continuous feed;
- `_revs_diff`, `_bulk_get`, and remote-to-remote PouchDB replication;
- the Mango selector subset LiveSync uses;
- LiveSync's `chunks/collectDangling` maintenance view and remote `_purge`;
- compaction, Basic authentication, CORS, and LiveSync's CouchDB configuration
  probes;
- direct Durable Object RPC from another Worker.

The hermetic protocol suite runs against the pinned registry dependencies. A
separate upstream-compatibility job checks out and builds current PouchDB before
dependency upgrades and on its scheduled run. This is a focused compatibility server, not a general
replacement for every CouchDB feature; see [COMPATIBILITY.md](../COMPATIBILITY.md).

The MCP Worker provides Streamable HTTP with GitHub OAuth and a numeric account
ID allowlist. Its implemented features include:

- file and attachment listings, full and ranged reads, bounded batch reads,
  and heading outlines;
- full-text search and frontmatter property filters with pagination;
- create, edit, append, patch, frontmatter update, and delete operations;
- revision-checked writes, create-only protection, and explicit conflict
  feedback, with writes disabled by default.

Automated tests cover tool behavior, OAuth and permission checks, and calls
across the MCP/storage Worker binding. MCP currently requires an unencrypted,
unobfuscated vault. See the [MCP reference](../apps/cloudflare-obsidian-mcp/README.md)
for the current interface and limits.

Optional R2 backups, retention, offline extraction, and restore are also
implemented, with [remote recovery tests](backup-staging-results.md) using two
Obsidian clients. Large-vault and mobile behavior still need broader testing.

[MCP_PLAN.md](../MCP_PLAN.md) records the architecture decisions and completed
implementation checkpoints.

## Worker hashing compatibility

WASM initialization works in the current Worker build. The alias in
`wrangler.jsonc` routes Octagonal Wheels' xxHash entrypoint through
`src/livesync-vault/worker-xxhash.ts`, which uses the `workerd` export of
`xxhash-wasm` 1.1.0. That export imports a precompiled WASM module instead of
compiling embedded bytes at runtime. The same alias is used in the workerd
test configuration.

This resolves the runtime incompatibility while preserving LiveSync's hashing
behavior. Commonlib still owns hashing selection, chunking, and serialization.
Keep the alias with the pinned dependencies; remove it only after an upstream
Worker-compatible loader is adopted and verified. This is a maintained
compatibility shim, not an outstanding WASM failure.

## Local development

This npm workspace uses one lockfile and registry-backed production
dependencies; a clean clone does not require sibling repositories.

```sh
npm install
cp .dev.vars.example .dev.vars
npm run types
npm run check
npm test
npx wrangler dev
```

`COUCHDB_USERNAME` and `CORS_ORIGINS` are non-secret variables in
`wrangler.jsonc`. Do not put the password in that file.

## Access from another Worker

Bind the existing Durable Object class from another Worker:

```jsonc
{
  "durable_objects": {
    "bindings": [
      {
        "name": "POUCH_DATABASES",
        "class_name": "PouchDatabase",
        "script_name": "obsidian-sync"
      }
    ]
  }
}
```

Then use the same database name that LiveSync uses:

```ts
const vault = env.POUCH_DATABASES.getByName("vault");
await vault.ensureDatabase("vault");

const note = await vault.getDocument("vault", "notes/example.md");
await vault.putDocument("vault", {
  ...note,
  data: "updated content"
});
```

The raw document RPC surface includes `ensureDatabase`, `getDocument`,
`putDocument`, and `allDocuments`. MCP uses the file-level RPC methods, such as
`readVaultFile`, `searchVaultFiles`, and `createVaultFile`, with shared request
and response types in `packages/livesync-contracts`. The Durable Object's `fetch()` method also
exposes the complete implemented CouchDB surface when a caller needs replication
or maintenance operations.

## Verification

```sh
npm run types:check
npm run check
npm run test:all          # storage, MCP/OAuth, and script suites
npm run dry-run
```

For a separate upstream compatibility check, run `npm run test:current-pouchdb`.
This suite expects `../pouchdb` to have dependencies installed
and `npm run build-modules` completed. The adapter's own workerd tests live in
`../pouchdb-adapter-sqlite/packages/pouchdb-adapter-cloudflare-do`.
