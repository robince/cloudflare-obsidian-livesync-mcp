# Obsidian LiveSync MCP — minimal write-capable plan

## Goal

Build the smallest useful authenticated MCP server that can list, read, create,
edit, and delete Markdown files in one existing Self-hosted LiveSync vault
without disrupting normal Obsidian replication.

Writes are included because they are essential to the first useful release.
They remain disabled by default until the compatibility and concurrency tests
in this plan pass. Move and rename are deliberately excluded: LiveSync has no
atomic move primitive, and clients can explicitly create a copy and then delete
the source when that behaviour is wanted.

## Fixed compatibility target

- Self-hosted LiveSync `1.0.21`
- Upstream tag commit `f5f7aab11f03f62c6946d2fa296c50bb5df5b2a4`
- `@vrtmrz/livesync-commonlib@0.1.19`

No historical LiveSync releases are in scope.

## Architecture

- Keep the deployed `cloudflare-pouchdb` Worker, `PouchDatabase` class,
  Durable Object namespace, migrations, and CouchDB routes unchanged.
- A separate stateless MCP Worker calls additive semantic Durable Object RPC.
- One MCP deployment addresses one fixed `VAULT_DATABASE`; callers never
  provide a database name.
- Commonlib owns LiveSync path handling, chunking, hashing, serialization, and
  logical file reads. A fixed-database in-process fetch bridge connects it to
  the existing Durable Object router and never falls back to network fetch.
- The MCP Worker owns OAuth, authorization, the write kill switch, and tool
  formatting. The storage Worker owns vault access and revision checks.

## V1 surface

Supported tools:

- `vault_status`
- `list_files`
- `read_file`
- `create_file`
- `edit_file`
- `delete_file`

Not supported:

- move, rename, patch, or bulk mutations;
- encryption or path obfuscation;
- non-Markdown and binary notes;
- search, indexing, or automatic chunk garbage collection;
- historical LiveSync versions.

## Completed checkpoints

- `3e2efce` — reproducible npm workspace.
- `cec27f9` — current LiveSync 1.0.21 read compatibility.
- `d3bccda` — semantic read RPC.
- `3780b4c` — authenticated read MCP Worker.

Later commits started write support and review fixes. They are being completed
in the write checkpoint below rather than removed or hidden.

## Current checkpoint — safe minimal writes and review closure

### Storage and Commonlib

1. Route Commonlib through the Worker-compatible `xxhash-wasm` loader and use
   LiveSync's `xxhash64` algorithm. Do not replace LiveSync hashing or
   serialization locally.
2. Add the smallest version-pinned Commonlib compatibility patch needed for a
   create-only write: omit `_rev`, write through normal PouchDB `put`, and map a
   concurrent `409` to `conflict`.
3. Keep edits revision-checked with `putDBEntryWithLiveBaseRevision`.
4. Keep deletes as a tombstone written with the exact expected revision.
5. Write chunks before metadata. A losing create may leave unreferenced chunks;
   do not delete them inline.
6. Close Commonlib after each RPC and abort any outstanding `_changes`
   long-poll when the operation ends.

### MCP and authorization

1. Remove `move_file` from contracts, RPC, tools, tests, and documentation.
2. Add `MCP_WRITES_ENABLED`, default `false`.
3. When writes are disabled, do not advertise write tools or the write OAuth
   scope, and reject every write handler independently.
4. When enabled, writes require an allowlisted GitHub login and both
   `vault:read` and `vault:write`.
5. Token exchange may only narrow granted scopes; it must never invent a scope
   for an empty or unknown requested scope.
6. Continue resolving only the configured `VAULT_DATABASE`.

### Required tests

- exact current-client fixture reads through workerd;
- workerd writes produce current LiveSync `xxhash64` chunk IDs and round-trip;
- two concurrent creates: exactly one winner and no conflict branch;
- two edits from one revision: exactly one winner;
- delete/update race: exactly one winner;
- stale edits and deletes return `conflict`;
- writes are absent and denied when the kill switch is off;
- write authorization requires both scopes and the runtime allowlist;
- one local MCP-to-storage integration covers status, list, read, create, edit,
  and delete through the real Durable Object RPC boundary;
- existing CouchDB replication tests remain green.

### Gate

Run dependency checks, typechecks, all tests, both Worker dry-runs, and
`git diff --check`. Submit the complete diff and results to independent Terra
reviews for Commonlib/storage and MCP/auth. Fix findings before committing.

Checkpoint commit:

```text
feat: complete guarded livesync writes
```

## Next checkpoint — disposable-vault staging

1. Deploy the additive storage RPC.
2. Confirm existing Obsidian replication still works.
3. Deploy MCP with `MCP_WRITES_ENABLED=false` and verify status/list/read.
4. Enable writes for the allowlisted test account.
5. Create, edit, and delete designated test notes and confirm propagation to
   two current LiveSync 1.0.21 clients.
6. Exercise stale revisions, the write kill switch, token revocation, and
   MCP-only rollback.
7. Record sanitized evidence and runbooks without committing identifiers,
   vault content, OAuth credentials, or secrets.

This checkpoint pauses for deployment credentials and interactive client
access. It receives a separate Terra review and commit.

## Commit discipline

- Review and test each checkpoint before its atomic commit.
- Do not amend, squash, rebase, or rewrite approved checkpoint commits.
- Do not mix unrelated user changes into a checkpoint.
- Production identifiers and secrets are supplied out of band and never
  committed.
