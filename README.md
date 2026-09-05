# Cloudflare PouchDB

An experimental CouchDB-compatible endpoint backed by a PouchDB database in a
SQLite Durable Object. Each CouchDB database name maps to one Durable Object,
so its writes are serialised and its data remains isolated from every other
database.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/robince/cloudflare-obsidian-livesync)

See [DEPLOY.md](DEPLOY.md) for private-repository collaborator instructions,
required secrets, and the public one-click deployment flow.

The immediate target is Obsidian LiveSync. The same Durable Object also exposes
RPC methods so another Worker can read and write the vault without going back
through HTTP, for example an Obsidian MCP Worker.

## Current status

The implementation passes workerd integration tests for:

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
replacement for every CouchDB feature; see [COMPATIBILITY.md](COMPATIBILITY.md).

The selected architecture and phased implementation plan for logical Obsidian
vault access and a separate MCP Worker are documented in
[MCP_PLAN.md](MCP_PLAN.md).

See the [forward roadmap](docs/roadmap.md) for the next priorities: reliable,
approachable open-source deployment into an individual Cloudflare free account,
with optional MCP access.

## Deploy

Follow [DEPLOY.md](DEPLOY.md) to deploy from this private repository with
Wrangler. The Deploy to Cloudflare button works once the repository is public.

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

## Obsidian LiveSync

Use these CouchDB settings in LiveSync:

- URI: the deployed Worker URL, without a database suffix;
- database name: a lower-case CouchDB name such as `vault`;
- username: the configured `COUCHDB_USERNAME` (`admin` by default);
- password: `COUCHDB_PASSWORD`.

The endpoint supports LiveSync's setup and configuration checks. Leave
LiveSync's custom chunk size at its default (`0`, approximately 100 KB chunks).
Durable Object SQLite has a hard 2 MB maximum for any single string or BLOB;
this service rejects documents above 1.8 MB and attachments above 900 KB to
preserve room for PouchDB metadata and binary-string encoding. The emulated
CouchDB configuration values exist for LiveSync's CouchDB-specific setup check
and do not raise that Cloudflare limit.

The default LiveSync chunking is comfortably within the limit. Large custom
chunk-size values intended for a conventional CouchDB server are not compatible.

## Backups

Daily backups export the single configured vault to a private R2 bucket provisioned
at deployment, with 30 daily, 8 weekly, and 24 monthly recovery points.
See [backup and recovery](docs/backup-recovery.md) for configuration, offline vault
extraction, and restore through LiveSync.

## Access from another Worker

Bind the existing Durable Object class from another Worker:

```jsonc
{
  "durable_objects": {
    "bindings": [
      {
        "name": "POUCH_DATABASES",
        "class_name": "PouchDatabase",
        "script_name": "cloudflare-pouchdb"
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

The public RPC surface currently includes `ensureDatabase`, `getDocument`,
`putDocument`, and `allDocuments`. The Durable Object's `fetch()` method also
exposes the complete implemented CouchDB surface when a caller needs replication
or maintenance operations.

## Verification

```sh
npm run check
npm test                 # published PouchDB 9 protocol suite
npm run test:current-pouchdb
npm run dry-run
```

The current-checkout suite expects `../pouchdb` to have dependencies installed
and `npm run build-modules` completed. The adapter's own workerd tests live in
`../pouchdb-adapter-sqlite/packages/pouchdb-adapter-cloudflare-do`.
