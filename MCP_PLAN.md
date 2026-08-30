# Read-only Obsidian LiveSync MCP — minimal implementation plan

## Goal

Build the smallest useful authenticated MCP server that can inspect, list, and
read Markdown files from one existing Self-hosted LiveSync vault without
changing that vault or disrupting normal Obsidian replication.

The first release is deliberately read-only. Writes, historical compatibility,
and production-hardening exercises are not prerequisites for proving the core
product works.

## Fixed compatibility target

- Self-hosted LiveSync `1.0.21`
- Upstream tag commit `f5f7aab11f03f62c6946d2fa296c50bb5df5b2a4`
- Its lockfile dependency: `@vrtmrz/livesync-commonlib@0.1.19`
- This repository pins the same Commonlib version.

No older LiveSync release is in scope. When LiveSync is upgraded, compatibility
with the new current version will be checked then.

## Architecture kept from the original design

- The deployed `cloudflare-pouchdb` Worker, `PouchDatabase` class, Durable
  Object namespace, migrations, and CouchDB routes remain unchanged.
- A separate stateless MCP Worker calls additive semantic Durable Object RPC.
- One MCP deployment addresses one fixed `VAULT_DATABASE`; callers never
  provide a database name.
- Commonlib reads the authoritative PouchDB data through a fixed-database
  in-process fetch bridge. The bridge never falls back to network `fetch`.
- The MCP Worker owns authentication and tool formatting. The storage Worker
  owns vault access.

## Scope of the first release

Supported:

- unencrypted, unobfuscated LiveSync vaults;
- Markdown files;
- compatibility/status inspection;
- bounded file listing;
- complete file reads;
- GitHub-authenticated, deny-by-default allowlisted MCP access.

Not supported:

- create, update, delete, move, rename, patch, or bulk mutation;
- encryption or path obfuscation;
- historical LiveSync versions;
- search or indexing;
- snapshot pagination guarantees;
- line-range reads;
- automatic chunk garbage collection;
- certification across multiple MCP clients.

## Checkpoint 0 — Reproducible workspace

Already complete at commit `3e2efce` (`chore: establish reproducible
workspace`). It provides one lockfile, npm workspaces, registry-backed
dependencies, generated Worker types, dependency provenance checks, tests, and
dry-run commands.

## Checkpoint 1 — Current LiveSync read compatibility

Implement only what is required to prove logical reads:

1. Keep the fixed-database `InProcessCouchFetch` bridge and its focused security
   tests: fixed dummy origin, captured database identity, overwritten database
   header, removed authorization, rejected redirects, and no network fallback.
2. Generate one small synthetic fixture using the official Self-hosted LiveSync
   `1.0.21` CLI and Commonlib `0.1.19`.
3. Include representative Markdown content in that fixture: frontmatter,
   Unicode path/content, CRLF, and one chunked note.
4. Import the fixture into workerd and read those files byte-for-byte through
   Commonlib and the in-process bridge.
5. Detect encryption and path obfuscation from remote metadata and report them
   as unsupported. Small metadata unit tests are sufficient; do not generate a
   fixture matrix.
6. Keep every Commonlib integration method private. Add no write method or
   write RPC.

Exit criteria:

- the `1.0.21` fixture reads byte-for-byte through the real bridge;
- the bridge cannot escape its Durable Object or database identity;
- encrypted and obfuscated profiles fail closed;
- existing CouchDB tests and Worker dry-run remain green.

One focused Terra review checks only these criteria. Findings about writes,
historical versions, exhaustive failure injection, or future production
hardening do not expand this checkpoint.

Checkpoint commit:

```text
feat: add current livesync read compatibility
```

## Checkpoint 2 — Minimal read-only vault RPC

Add a small internal contracts workspace and three semantic methods:

```ts
vaultStatus()
listVaultFiles({ prefix?, limit?, cursor? })
readVaultFile({ path })
```

Requirements:

- contracts use runtime schemas and structured-clone-compatible values;
- vault identity is derived internally and never accepted by RPC;
- paths are relative Markdown paths without traversal or internal document IDs;
- listing is deterministic, bounded, and best-effort under concurrent edits;
- cursors are opaque but need not provide snapshot isolation;
- reads preserve Unicode and newline bytes;
- conservative limits stay below known Worker/RPC/storage constraints;
- errors cover only the cases actually used: invalid input, not found,
  unsupported configuration, too large, temporarily unavailable, and internal;
- existing CouchDB routes and legacy RPC remain unchanged.

No `writeVaultFile`, write contracts, revision CAS, line ranges, or complex
pagination model are included.

After tests and one focused Terra review, commit:

```text
feat: add read-only vault rpc
```

## Checkpoint 3 — Minimal authenticated MCP Worker

Build `apps/cloudflare-obsidian-mcp` with stateless Streamable HTTP MCP and
register:

- `vault_status`
- `list_files`
- `read_file`

Requirements:

- fixed cross-Worker `POUCH_DATABASES` binding and `VAULT_DATABASE` setting;
- Cloudflare OAuth provider with GitHub login;
- deny-by-default GitHub allowlist;
- one `vault:read` scope checked at tool execution;
- standard provider support for PKCE, metadata, and client registration;
- bounded schemas and concise structured tool results;
- fake-RPC tool tests plus one local two-Worker status/list/read test;
- malicious tool input cannot select another database.

Do not add write scopes, a write switch, custom token machinery, or exhaustive
OAuth permutations.

After tests and one focused Terra review, commit:

```text
feat: add read-only obsidian mcp worker
```

## Checkpoint 4 — Small staging proof

Using one disposable vault on the current Self-hosted LiveSync version:

1. Deploy the additive storage RPC.
2. Confirm existing Obsidian replication still works.
3. Deploy the read-only MCP Worker.
4. Connect one intended MCP client.
5. Verify status, listing, Unicode/frontmatter/newline content, and a chunked
   read.
6. Record minimal deployment, secret, revocation, and MCP-only rollback steps
   without committing identifiers or secrets.

This checkpoint requires external deployment credentials and an interactive
client, so repository implementation stops and asks for those inputs when
needed.

After staging evidence and one focused Terra review, commit:

```text
test: validate read-only mcp staging
```

## Review and commit discipline

- Each checkpoint starts from the previous checkpoint commit.
- One implementation agent may be used for a clearly bounded package or test.
- One independent Terra review checks only the stated exit criteria.
- Review does not expand the checkpoint with deferred features.
- Fix in-scope findings, run the checkpoint suite, check `git diff --check`, and
  commit only checkpoint-related files.
- Do not amend, squash, rebase, or mix unrelated changes into checkpoint
  commits.

## Deferred decisions

Writes will be reconsidered only after the read-only MCP is useful in practice.
That separate design must address create-only CAS, guarded updates, conflicts,
partial failures, orphan chunks, recovery, and a write kill switch. None of
those concerns block this read-only release.
