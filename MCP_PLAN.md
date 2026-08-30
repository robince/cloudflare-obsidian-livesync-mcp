# Obsidian LiveSync MCP implementation plan

## 1. Goal

Add an authenticated remote MCP server that gives AI clients flexible, efficient,
logical access to one Obsidian LiveSync vault, while preserving ordinary LiveSync
replication in both directions across all connected devices.

The first usable release will support:

- inspecting vault compatibility and status;
- listing Markdown files;
- reading a complete file, with an optional line range to reduce returned tokens;
- creating a Markdown file;
- updating a Markdown file with optimistic concurrency protection.

Search, indexing, encryption, path obfuscation, patch/move operations, and bulk
administration are deliberately deferred. Delete is also deferred until the
read/create/update path has passed multi-device propagation and conflict tests.

The design priorities, in order, are:

1. never corrupt or silently overwrite LiveSync data;
2. stay compatible with the LiveSync document format by using
   `@vrtmrz/livesync-commonlib` wherever practical;
3. keep the authoritative data in the existing `PouchDatabase` Durable Object;
4. make the MCP deployment independently secure and reversible;
5. avoid making local progress depend on upstream Commonlib changes;
6. optimize performance only after the compatibility-first path is proven.

## 2. Decisions already made

### 2.1 One MCP deployment, one configured vault

The MCP Worker has one non-secret `VAULT_DATABASE` setting. MCP tools never take
a database or vault name from the caller, so an authenticated client cannot use
tool arguments to reach another Durable Object.

The existing storage Worker may continue to route CouchDB HTTP requests for
other database names. That behavior is already part of the storage service and
does not make the MCP multi-vault: the MCP binding always resolves only the
configured `VAULT_DATABASE`. Removing the storage Worker's general CouchDB
routing is unnecessary for this feature and would create unrelated migration and
regression risk. It can be restricted later as a separate product decision.

### 2.2 Separate MCP and storage Workers

Use a stateless MCP Worker that calls semantic methods on the existing
`PouchDatabase` Durable Object through a cross-Worker Durable Object binding.

```text
ChatGPT / Claude / Grok
          │ MCP over Streamable HTTP + OAuth 2.1
          ▼
cloudflare-obsidian-mcp Worker
          │ typed Durable Object RPC
          │ fixed VAULT_DATABASE (not caller supplied)
          ▼
PouchDatabase Durable Object
          │
          ├── existing CouchDB facade and PouchDB database
          └── LiveSyncVault adapter using Commonlib
                     │
                     └── LiveSync documents/chunks (authoritative truth)

Obsidian clients ── CouchDB/LiveSync replication ──► same PouchDatabase object
```

The MCP Worker owns authentication, authorization, input validation, tool
definitions, and response formatting. It does not hold CouchDB Basic Auth
credentials, reconstruct chunks itself, access PouchDB SQL tables, or store a
second copy of vault content.

The storage Worker remains deployed as `cloudflare-pouchdb`, with Durable Object
class `PouchDatabase` and its existing namespace/migration identity. The MCP
binding uses:

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

The storage Worker is deployed first whenever the MCP Worker requires a new RPC
method. RPC additions must remain backwards-compatible with the previous MCP
release so either deployment can be rolled back independently.

### 2.3 Cloudflare OAuth provider with GitHub identity

This is not a choice between “Cloudflare OAuth” and “GitHub OAuth.” They serve
different layers:

- `@cloudflare/workers-oauth-provider` implements the MCP-facing OAuth 2.1
  authorization server, metadata, dynamic client registration, PKCE, access and
  refresh tokens, and verified authentication context supplied to the MCP route;
- GitHub OAuth is the upstream login and identity check;
- an explicit GitHub allowlist determines who may authorize this MCP server.

Reuse the useful policy from `../obsidian-mcp`—GitHub login, allowlisting, and
scope-conscious authorization—but do not copy its framework-specific or private
token-validation implementation. Use only public Cloudflare and MCP APIs.

The first scopes are:

```text
vault:read     status, list, and read
vault:write    create and guarded update (requires vault:read as well)
```

Every tool checks its required scope at execution time. Advertising a scope is
not sufficient authorization.

### 2.4 Commonlib compatibility without an upstream dependency

Pin and use the published `@vrtmrz/livesync-commonlib@0.1.19` package initially.
That version has been confirmed to bundle and execute in a Worker with
`nodejs_compat`; later upgrades use the dependency gate in section 11.

The initial integration is compatibility-first:

```text
LiveSyncVault
    └── Commonlib DirectFileManipulator / supported file APIs
            └── PouchDB HTTP adapter with InProcessCouchFetch
                    └── existing PouchDatabase CouchDB router
                            └── the same local PouchDB database
```

The published 0.1.19 API has been inspected and supports this directly:
`DirectFileManipulator` (the V2 class exported from the package root) accepts a
second constructor argument, `DirectFileManipulatorRuntimeOptions`, whose
`fetch` member is documented as "Fetch implementation passed to PouchDB." No
upstream change is needed to inject the in-process transport.

`InProcessCouchFetch` is a small local adapter that satisfies that `fetch`
signature and dispatches the CouchDB requests Commonlib issues directly to the
Durable Object's existing router. It must not make an external network request,
pass through the public Worker, or forward credentials. Because the manipulator
constructor requires `url`, `username`, and `password`, the service passes
fixed dummy values; the adapter ignores the resulting `Authorization` header
and never sends it anywhere. The adapter and Commonlib manipulator can be
lazily initialized and cached per Durable Object instance; request or user
state must not be kept in module globals.

The manipulator's internal PouchDB uses the HTTP adapter: it is a stateless
protocol client, not a second data store. Nothing is copied or replicated;
each operation is translated into one CouchDB request against the single
authoritative database. The cost of this mode is per-operation serialization,
not duplication.

There is also a deeper integration mode that avoids the HTTP shape entirely.
`DatabaseService.createPouchDBInstance` is a designed override point — its
dependency contract documents `pouchDB` as "PouchDB with the adapters required
by the host runtime already registered", and `PouchDBConstructor` is
`typeof PouchDB` from `pouchdb-core`, the same `^9` family this service uses.
A local subclass of `DirectFileManipulator` can override
`getBoundDatabaseService` so `createPouchDBInstance` returns the Durable
Object's existing SQLite-backed PouchDB instance directly. Commonlib then
operates on the authoritative database with no second PouchDB client and no
per-operation serialization. The costs: coupling to a semi-internal override
that may churn across 0.1.x, and bypassing the CouchDB router — including its
size checks and its hand-written `_find`/`collectDangling` view emulation — so
write sizes must be enforced from resolved settings plus the service's own
caps, and any `query`/`find` call Commonlib makes in direct-access mode must
be confirmed served (or the missing plugin registered on the instance).

Phase 1 spikes both modes. The fetch bridge is the compatibility-first
baseline: it touches only documented API and exercises exactly the router path
real LiveSync clients use. Direct instance injection is preferred if the
spike's inventory of PouchDB methods invoked in direct-access mode comes back
fully served by the SQLite instance. Whichever loses remains the documented
fallback.

This is acceptable for the first release because it avoids reimplementing
LiveSync's file/chunk format either way. A fork is created only if a concrete,
release-blocking compatibility bug cannot be isolated locally.

Guarded update requires a lower-level exported API. The top-level
`DirectFileManipulator.put(path, data, info)` takes no revision, returns only a
boolean, and internally builds a document without `_rev` before delegating to
`putDBEntry` — read-merge-write, last-writer-wins. It cannot implement
section 4.5, and a check-then-`put()` wrapper still races with device
replication (Durable Object input gates only close during storage operations).
The manipulator exposes `manipulator.liveSyncLocalDB`, whose exported
`putDBEntry(note, onlyChunks?, conflictBaseRev?)` and
`putDBEntryWithLiveBaseRevision(note, baseRevision, onlyChunks?)` are the
candidate primitives. The Phase 1 spike must settle two things:

- whether a stale `conflictBaseRev`/`baseRevision` is rejected or deliberately
  written as a CouchDB conflict branch (LiveSync's native merge-later model);
  MCP requires reject/fail-closed semantics, never a new conflict branch;
- that the race-free construction works: write chunks first (`onlyChunks`),
  then write the metadata document with `_rev = expectedRevision` so CouchDB's
  own compare-and-swap rejects stale updates at the database layer.

Wrap whichever primitive wins locally behind `LiveSyncVault`; do not copy the
file format implementation into MCP code.

### 2.5 Supported vault profile

The initial release supports unencrypted, unobfuscated LiveSync vaults and an
initial file filter of `.md`. The extension list is configurable at deployment
time, but expanding it requires datatype and response-size tests.

Commonlib should still handle the compatible current/legacy LiveSync document,
chunk, compression, and Eden details that it supports. The service must resolve
the effective remote LiveSync settings—including chunk/hash/splitter and related
tweak values—from the vault's synchronization metadata rather than silently
assuming Commonlib defaults.

Compatibility risk is bidirectional: the vault format can move ahead of the
pinned Commonlib when the user upgrades the Obsidian plugin. Any tweak value the
pinned version does not recognize — an unknown `chunkSplitterVersion`,
`E2EEAlgorithm`, or new setting — is therefore treated as unsupported, not only
values known to be incompatible. This check runs (cached, with invalidation)
before every write.

If encryption, path obfuscation, or another unsupported setting is detected:

- `vault_status` reports the exact unsupported capability;
- content tools return a structured `unsupported_configuration` error;
- writes fail closed;
- the service never changes remote LiveSync settings on the user's behalf.

## 3. Component boundaries

### 3.1 `PouchDatabase`

Continue to own the PouchDB instance and CouchDB-compatible HTTP routing. Add
only semantic, serializable RPC methods that delegate to `LiveSyncVault`:

```ts
vaultStatus(): Promise<VaultStatusResult>
listVaultFiles(request: ListFilesRequest): Promise<ListFilesResult>
readVaultFile(request: ReadFileRequest): Promise<ReadFileResult>
writeVaultFile(request: WriteFileRequest): Promise<WriteFileResult>
```

Do not expose arbitrary CouchDB requests, PouchDB handles, SQL, or RPC stubs to
the MCP Worker. Do not query or modify the adapter's private SQLite schema.

### 3.2 `LiveSyncVault`

Own all logical vault semantics:

- loading and validating the effective LiveSync profile;
- normalizing and validating paths;
- filtering visible file types;
- translating between logical files and Commonlib operations;
- stable pagination;
- line-range response shaping;
- create-versus-update rules;
- optimistic concurrency and structured conflicts;
- mapping internal errors to a small, serializable error vocabulary.

The class is constructed with an explicit database/transport dependency so it
can be tested against fixtures. It must not know about OAuth or MCP.

### 3.3 MCP Worker

Use the current stateless `createMcpHandler()` Streamable HTTP integration. For
each call it:

1. receives verified OAuth context;
2. checks GitHub identity and required MCP scope;
3. validates tool input with bounded schemas;
4. obtains `env.POUCH_DATABASES.getByName(env.VAULT_DATABASE)`;
5. invokes one semantic RPC;
6. formats a concise MCP result and structured error.

No tool is permitted to override `VAULT_DATABASE`.

## 4. First-release contracts

Keep shared request/result/error types in a small internal contracts package.
All values crossing RPC are plain structured-clone-compatible data.

### 4.1 Common error model

```ts
type VaultErrorCode =
  | "invalid_path"
  | "unsupported_file_type"
  | "not_found"
  | "already_exists"
  | "revision_conflict"
  | "unsupported_configuration"
  | "content_too_large"
  | "unauthorized"
  | "forbidden"
  | "temporarily_unavailable"
  | "internal_error";

interface VaultError {
  code: VaultErrorCode;
  message: string;
  path?: string;
  expectedRevision?: string;
  currentRevision?: string;
  retryable: boolean;
  requestId: string;
}
```

Errors must not include note contents, secrets, tokens, raw database documents,
or stack traces. A revision conflict may include the current revision so the
client can reread and retry deliberately.

### 4.2 `vault_status`

Returns:

- service and contract version;
- configured database availability without exposing other database names;
- Commonlib version;
- compatible/unsupported status and reasons;
- encryption and path-obfuscation detection;
- allowed file extensions;
- maximum list/read/write sizes;
- enabled OAuth scopes and write capability.

It must not expose credentials or internal synchronization documents.

### 4.3 `list_files`

Input:

```ts
interface ListFilesRequest {
  prefix?: string;
  limit?: number;       // default 100, hard maximum 200
  cursor?: string;      // opaque continuation cursor
}
```

Output entries contain `path`, `revision`, `size`, and available LiveSync
`ctime`/`mtime` values. Results are ordered deterministically by LiveSync
document ID, which is path-derived (case handling follows the vault's
`handleFilenameCaseSensitive` setting); Commonlib's enumeration APIs paginate by
ID `startKey`/`endKey`, and ordering by display path would require full
enumeration per page. The cursor is an opaque encoding of the last document ID;
it is not a promise of
snapshot isolation if Obsidian edits the vault between pages. Only configured
file extensions are returned. Listing should enumerate metadata only and must not
reconstruct every file's content. Phase 1 benchmarks will decide whether bounded
enumeration is adequate before introducing any derived listing projection.

### 4.4 `read_file`

Input:

```ts
interface ReadFileRequest {
  path: string;
  startLine?: number;   // 1-based; requires lineCount
  lineCount?: number;   // bounded by response policy
}
```

Return the normalized path, whole-file revision, selected content, size,
`ctime`/`mtime` when present, total line count, returned line interval, and a
`truncated` flag. A range reduces tokens sent to the model; Commonlib may still
need to reconstruct the complete logical file internally. The revision always
identifies the complete file, not the selected range.

### 4.5 `write_file`

Use one explicit create/update contract rather than a blind upsert:

```ts
type WriteFileRequest =
  | {
      mode: "create";
      path: string;
      content: string;
    }
  | {
      mode: "update";
      path: string;
      content: string;
      expectedRevision: string;
    };
```

Rules:

- create fails with `already_exists` if a live file occupies the path;
- update fails with `not_found` if the file is absent;
- update fails with `revision_conflict` unless `expectedRevision` is the current
  logical file revision;
- there is no force/blind overwrite mode in the first release;
- path and size validation occurs before any mutation;
- a successful response returns the new revision and resulting metadata;
- LiveSync-compatible chunks and metadata are written through Commonlib-backed
  operations in the required order;
- partial failure tests must demonstrate that no successfully readable file is
  replaced by an incomplete new version;
- a failed revision check after chunks are written leaves unreferenced chunk
  documents behind. This matches LiveSync's own write order and is accepted:
  orphaned chunks are content-addressed, immutable, and invisible to clients,
  and a reread-and-retry typically re-references the same chunks rather than
  leaking them. The service never deletes chunks inline as compensation —
  content-addressed chunks may be concurrently referenced by replicating
  devices, so inline deletion is the unsafe option. Orphans remain enumerable
  through the existing `chunks/collectDangling` view; garbage collection is an
  explicit, operator-invoked maintenance task deferred alongside delete
  support, never an automatic side effect of a failed write.

The caller obtains `expectedRevision` from `read_file` or `list_files`. Normal
LiveSync replication then propagates the resulting CouchDB changes to every
connected Obsidian client.

## 5. Path, content, and resource policy

Normalize separators to `/` and reject:

- empty or absolute paths;
- `.` or `..` segments and traversal after normalization;
- NUL/control characters;
- LiveSync internal/configuration document identifiers;
- paths outside the configured extension allowlist;
- names exceeding documented path limits.

Start with conservative configurable limits, defined once in the contracts or
service configuration:

- list page: default 100, maximum 200 entries;
- read response: maximum byte and line count;
- write content: maximum UTF-8 byte count;
- Markdown text only for the first release.

All byte caps must sit safely below both the Workers RPC serialized message
size limit (verify the currently documented value) and the storage router's
existing 1.8 MB per-document cap, allowing for JSON and revision-metadata
overhead.

If a complete read would exceed the response limit, return
`content_too_large` with guidance to use a line range. Never silently truncate a
full-file request. Validate UTF-8 behavior and newline preservation in fixtures.

## 6. Authentication and authorization design

### 6.1 Bindings and configuration

The MCP Worker requires:

```text
POUCH_DATABASES              cross-Worker Durable Object binding
OAUTH_KV                     OAuth provider state/token KV namespace
VAULT_DATABASE               fixed LiveSync database name
MCP_PUBLIC_BASE_URL          canonical production origin
MCP_FILE_EXTENSIONS          initially .md
GITHUB_ALLOWED_LOGINS        explicit normalized allowlist
```

Secrets:

```text
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
COOKIE_ENCRYPTION_KEY
```

Use separate GitHub OAuth applications and callback URLs for local/staging and
production. Never add an “allow any authenticated GitHub user” fallback. Store
the immutable GitHub user ID and normalized login in the granted token props so
authorization and audit records do not rely solely on a display name.

### 6.2 OAuth flow hardening

The authorization UI must include an explicit consent step and requested scopes.
Implement and test:

- Authorization Code with PKCE;
- dynamic client registration as required by remote MCP clients;
- access and refresh token flows through the Cloudflare provider;
- OAuth metadata/discovery endpoints;
- exact callback and redirect URI validation;
- CSRF protection for login/consent state;
- canonical Host/Origin checks against `MCP_PUBLIC_BASE_URL`;
- scope narrowing and per-tool scope enforcement;
- deny-by-default GitHub allowlisting;
- logout/revocation behavior supported by the provider.

Do not log authorization codes, cookies, access/refresh tokens, GitHub tokens,
client secrets, or note contents.

## 7. Repository layout

Avoid moving the deployed storage Worker as a prerequisite. Add the MCP app and
shared contract incrementally:

```text
cloudflare-obsidian-livesync/
├── src/                              existing storage Worker
│   ├── index.ts
│   ├── pouch-database.ts
│   └── livesync-vault/               new logical vault layer
├── apps/
│   └── cloudflare-obsidian-mcp/       new MCP Worker/config/tests
├── packages/
│   └── livesync-contracts/            shared RPC value types and schemas
├── test/                              existing storage/compatibility tests
└── MCP_PLAN.md
```

Introduce npm workspaces only if they simplify clean installs and Wrangler
builds without destabilizing the root storage package. Otherwise, keep the MCP
app independently installable initially and extract the shared package once the
RPC shape is proven. The architectural boundary matters more than an immediate
directory migration.

## 8. Detailed implementation phases

### Phase 0 — Baseline and reproducible dependencies

Work:

1. Record the current passing baseline for type checking, unit/integration tests,
   current-PouchDB compatibility, and Wrangler dry run.
2. Replace sibling `file:` adapter dependencies with the exact published
   `@robince/pouchdb-adapter-cloudflare-do@1.1.2-cloudflare-do.0` release; the
   scoped name replaces the current unscoped `file:` package, so import
   specifiers change as well.
3. Let its declared dependency provide the compatible
   `@robince/pouchdb-adapter-sqlite-core`, unless this application imports core
   directly.
4. Pin `@vrtmrz/livesync-commonlib@0.1.19` initially and commit the
   registry-backed lockfile.
5. Add a lockfile check that rejects production dependencies resolved through
   `file:`, `link:`, or a parent/sibling checkout.
6. Generate Worker environment types from Wrangler configuration rather than
   maintaining handwritten binding types.

Exit criteria:

- `npm ci` succeeds with no sibling repositories present;
- existing checks and tests remain green;
- both adapter packages resolve from the npm registry;
- the storage Worker dry-run bundle succeeds with `nodejs_compat`;
- the baseline behavior and bundle size are recorded for later comparison.

### Phase 1 — Commonlib compatibility spike

This is the first risk-reduction milestone and must finish before MCP tool work.

Work:

1. Add representative unencrypted/unobfuscated LiveSync fixtures, including a
   plain note, chunked note, compressed/current-format note, Unicode path,
   legacy-compatible note, deletion/tombstone, and conflicting revisions.
2. Implement the minimal `InProcessCouchFetch` adapter over the existing
   `PouchDatabase` router. Prove that it never reaches the network and cannot
   select a database other than the Durable Object's own identity.
3. Instantiate `DirectFileManipulator` with fixed dummy CouchDB credentials and
   the in-process adapter supplied as `runtimeOptions.fetch`; also spike the
   direct-injection subclass from section 2.4 and inventory every PouchDB
   method Commonlib invokes in direct-access mode (`get`, `put`, `bulkDocs`,
   `allDocs`, `changes`, `bulkGet`, `revsDiff`, and any `query`/`find` usage).
4. Identify and document the exact exported Commonlib APIs used for enumeration,
   read, create, revision-aware update, and profile/tweak resolution — starting
   from `get`/`getByMeta`/`enumerateAllNormalDocs` and the
   `liveSyncLocalDB.putDBEntry` variants named in section 2.4.
5. Resolve the effective LiveSync configuration from synchronization metadata.
6. Detect encryption, path obfuscation, or unsupported/unknown tweak values and
   return a compatibility report without mutating the database.
7. Prove create and guarded update on fixtures, including chunk ordering and
   revision conflicts. Specifically: demonstrate that top-level `put()` alone is
   last-writer-wins; determine whether a stale `conflictBaseRev`/`baseRevision`
   is rejected or written as a conflict branch; and prove the chunks-first,
   metadata-with-`_rev` construction rejects a stale `expectedRevision` without
   changing the winning file.
8. Verify the bundler resolves Commonlib's `bgWorker` export to the direct
   (non-Web-Worker) build under workerd conditions, and that hashing and chunk
   splitting execute in the Worker on a real write — not merely that the module
   imports.
9. Measure Worker bundle size, startup, and representative read/write latency.

Exit criteria:

- fixture files round-trip byte-for-byte through Commonlib;
- changes produced by the adapter are readable by an actual LiveSync client;
- stale updates fail without changing the winning file;
- unsupported configurations fail closed;
- no copied/reimplemented LiveSync serialization code is required;
- any missing upstream extension has a local bridge or wrapper, so upstream work
  is an optimization rather than a blocker.

If this phase uncovers a genuine Commonlib incompatibility, stop before building
MCP writes and document the smallest reproducible case. Read-only work may
continue only if it is demonstrably safe; writes remain disabled until resolved.

### Phase 2 — Semantic vault RPC

Work:

1. Add the shared serialized request/result/error contract and a contract
   version.
2. Implement `LiveSyncVault` path policy and compatibility/profile caching with
   explicit invalidation when relevant synchronization metadata changes.
3. Implement `vaultStatus`, `listVaultFiles`, `readVaultFile`, and
   `writeVaultFile` on `PouchDatabase`.
4. Use deterministic path ordering and opaque bounded pagination.
5. Add optional 1-based line-range shaping to reads.
6. Implement create-only and expected-revision update semantics.
7. Translate PouchDB/Commonlib failures into the common error model.
8. Keep all new RPC methods additive and preserve existing CouchDB routes.

Exit criteria:

- direct Durable Object RPC tests cover every success and error branch;
- there is no database-name parameter in any public vault RPC;
- stale revision, create-existing, update-missing, invalid path, excessive size,
  and unsupported-profile cases are deterministic;
- existing CouchDB and current-PouchDB compatibility suites still pass;
- Durable Object restart/persistence tests pass.

### Phase 3 — Authenticated MCP Worker, including writes

Work:

1. Scaffold the separate MCP Worker using `createMcpHandler()` and the public
   MCP server SDK.
2. Configure the cross-script `PouchDatabase` binding and fixed
   `VAULT_DATABASE`.
3. Add `@cloudflare/workers-oauth-provider`, OAuth KV, GitHub login/allowlist,
   consent UI, PKCE, discovery, dynamic registration, and refresh flows.
4. Register `vault_status`, `list_files`, `read_file`, and `write_file`.
5. Require `vault:read` for status/list/read and `vault:write` plus `vault:read`
   for writes.
6. Validate all inputs with bounded schemas and return both concise human-readable
   MCP content and machine-readable structured results where supported.
7. Add explicit protocol and application-level version information.
8. Add local development configuration with injected/test auth so most tool
   tests do not depend on GitHub or public callbacks.

Exit criteria:

- MCP initialization and all four tools work over Streamable HTTP;
- an unauthenticated request cannot invoke a tool;
- a read-only grant cannot write;
- a permitted GitHub user can complete the OAuth flow;
- a non-allowlisted GitHub user is denied before a vault capability is granted;
- the MCP Worker cannot address a second database even with malicious tool input;
- MCP unit tests run against a fake typed RPC client;
- a local two-Worker test proves real MCP-to-Durable-Object list, read, create,
  update, and conflict propagation.

### Phase 4 — End-to-end device and client validation

Use a disposable staging vault and at least two LiveSync clients.

Required scenarios:

1. Device A creates/edits a note; MCP list/read observes it after replication.
2. MCP creates a note; devices A and B receive and render it correctly.
3. MCP reads a revision, device A updates it, and MCP's stale update returns a
   conflict without overwriting device A.
4. MCP updates the current revision; devices A and B receive the new content.
5. MCP create on an existing path fails without adding orphan logical content.
6. Network interruption or Worker restart during representative operations does
   not corrupt the existing readable revision.
7. Unicode paths, frontmatter, headings, CRLF/LF behavior, large-but-allowed
   notes, and chunk boundaries round-trip correctly.
8. Reconnect/restart catches up through normal LiveSync replication.

Then connect staging deployments manually from ChatGPT web, Claude web, and Grok
web. Record each client's OAuth registration behavior, supported MCP result
format, refresh/reconnect behavior, and whether write tools are exposed by that
client/account tier. Client UI limitations must not weaken server authorization.

Exit criteria:

- all required replication/conflict scenarios pass;
- failed writes never leave a partially referenced file: every metadata
  document's `children` list resolves to complete, readable content;
- orphaned chunks left by failed revision checks are bounded, invisible to
  clients, and fully enumerable via `chunks/collectDangling` — the count after
  the conflict scenarios matches exactly the chunks the failed attempts wrote
  and no other unexpected documents exist;
- each target web client has a documented result: supported, unsupported, or
  blocked by a named client/platform limitation;
- production secrets, bindings, callback URLs, and rollback steps are reviewed.

### Phase 5 — Production rollout and hardening

Work:

1. Deploy additive storage RPC changes first.
2. Run storage smoke tests through both CouchDB HTTP and direct vault RPC.
3. Deploy the MCP Worker with production GitHub OAuth credentials and allowlist,
   initially granting only `vault:read` so the service runs read-only in
   production first.
4. Before enabling `vault:write`, document and rehearse recovery: Durable
   Object SQLite offers point-in-time recovery through storage bookmarks
   (verify the current API and retention window while implementing), and every
   Obsidian client also holds a complete replica from which LiveSync's
   rebuild-remote flow can repopulate the database.
5. Run read-only smoke tests, then enable `vault:write` and run a create/update
   test on a designated canary note.
6. Monitor authentication denials, RPC latency, Commonlib errors, conflicts, and
   Worker/DO exceptions.
7. Document how to revoke OAuth clients/tokens, rotate secrets, remove MCP access,
   and roll back the MCP Worker without touching vault data.

Production gate:

- all CI and staging acceptance criteria pass;
- no secret or note content appears in logs;
- rollback of MCP does not require a storage rollback;
- storage rollback remains possible because RPC changes were additive;
- the existing Obsidian endpoint and Durable Object namespace are unchanged.

### Phase 6 — Deferred delete support

After create/update has operated safely in production, add:

```ts
deleteVaultFile({ path, expectedRevision })
```

Deletion must require `vault:write`, an exact current revision, Commonlib's
compatible tombstone/deletion semantics, confirmation-oriented tool description,
and multi-device propagation/recovery tests. Commonlib's top-level
`delete(path)` carries no revision guard, so the same lower-level guarded
construction as section 2.4 applies. There will be no wildcard, prefix,
recursive, or bulk delete in this phase.

### Phase 7 — Deferred search and indexing

Search is a separate design and implementation milestone. Before committing to
an index, evaluate a bounded scan tool: substring/regex over reconstructed
Markdown content with a hard cap on total bytes scanned and a
`(document ID, revision)`-keyed content cache, which is disposable by
construction and needs no maintenance, rebuild, or freshness semantics. For a
single-user vault this may be adequate indefinitely. If a real index is
warranted:

1. define search semantics and freshness requirements;
2. verify FTS5 virtual-table support in Durable Object SQLite (D1 has it;
   `ctx.storage.sql` must be confirmed — a LIKE-based projection is a materially
   different design), then add namespaced application-owned projection/FTS
   tables inside the same Durable Object SQLite database, without touching
   PouchDB private tables;
3. treat PouchDB revisions/chunks as authoritative and the index as disposable;
4. implement bounded incremental maintenance, checkpoints, reconciliation, full
   rebuild, and application schema versioning;
5. expose index/database sequence lag and temporary rebuild unavailability;
6. add `search` only after interruption/rebuild/deletion tests pass.

The user has accepted temporary search unavailability during rebuild. Search,
embeddings/Vectorize, R2 offload, and advanced recent-change tools are not part
of the initial MCP release.

## 9. Testing and CI matrix

### Storage and compatibility

- retain all existing CouchDB facade tests;
- retain the current-PouchDB compatibility suite;
- add Commonlib fixture tests for all supported document variants;
- add randomized/path-property tests for traversal and normalization;
- add write failure-injection and stale-revision tests;
- verify no direct access to PouchDB adapter SQL tables.

### Durable Object RPC

- serialization of every request, result, and error;
- pagination boundaries and mutations between pages;
- complete and ranged reads;
- create/update conflict matrix;
- unsupported vault profile behavior;
- concurrent device/MCP updates;
- restart and persistent state behavior.

### OAuth and MCP

- OAuth metadata, registration, PKCE, callback, refresh, and consent;
- redirect URI, Host/Origin, state, and CSRF rejection cases;
- GitHub allowlist allow/deny cases;
- scope enforcement for every tool;
- tool schema bounds and error formatting;
- fake-RPC unit tests plus a focused real two-Worker suite;
- no raw tokens or note bodies in captured logs.

### Release commands

CI should provide a single aggregate command and preserve focused commands for
diagnosis. At minimum it runs:

```text
npm ci
npm run check
npm test
npm run test:current-pouchdb
npm run test:mcp
npm run test:multi-worker
npm run dry-run
npm run dry-run:mcp
```

Exact script names can be adjusted while scaffolding, but clean install, both
Worker builds, the legacy storage suite, the Commonlib suite, OAuth/MCP tests,
and the cross-Worker suite are mandatory release gates.

## 10. Observability and operations

Emit structured logs containing only operational metadata:

- request/correlation ID;
- tool or RPC operation;
- contract/service version;
- stable GitHub user ID or a documented pseudonymous hash;
- result category and safe error code;
- duration and bounded size/count metrics;
- conflict and unsupported-configuration counters.

Never log note paths unless explicitly classified as acceptable metadata; the
safer default is to hash them. Never log note content, tokens, cookies, OAuth
codes, secrets, raw LiveSync documents, or CouchDB credentials.

Track at least authentication denials, authorization denials, tool error rate,
RPC latency, DO exceptions, Commonlib compatibility errors, write conflicts, and
response/write size rejections. Add alarms only after a normal staging baseline
is known.

## 11. Upstream and dependency strategy

Local development must remain self-sufficient:

- production consumes exact published versions from npm;
- the in-process Commonlib fetch bridge lives in this repository and is tested;
- all Commonlib imports are funneled through a single local module that
  re-exports exactly the symbols and types this service uses, so a breaking
  0.1.x release fails type checking in one place; that module doubles as the
  documented API inventory from Phase 1;
- upstream issues/PRs contain minimal reusable improvements, not product-specific
  authorization or Worker architecture;
- upstream acceptance never blocks the initial release;
- a sibling checkout may be used for explicit dependency development, but no
  deployable lockfile or CI path may rely on it;
- upgrade Commonlib or the SQLite adapter only through a fixture regression,
  clean install, both Worker dry runs, and multi-device canary test.

No upstream transport proposal is required: the published V2
`DirectFileManipulator` already accepts an injected `fetch` through
`DirectFileManipulatorRuntimeOptions`. Remaining upstream candidates (for
example, first-class reject-on-stale-revision write semantics) are
optimizations; if accepted, adopt them only after parity and performance tests,
and preserve the local wrapper as a known rollback path for at least one
release.

## 12. Explicitly deferred or rejected alternatives

- **Reimplement MCP OAuth/token issuance around GitHub:** rejected because the
  Cloudflare provider supplies the MCP OAuth protocol while GitHub remains the
  identity provider.
- **Cloudflare Access alone:** not the selected MCP OAuth surface for the target
  web clients.
- **Caller-selected database/vault:** rejected for the one-MCP/one-vault model.
- **Expose raw CouchDB or SQL through MCP:** rejected for safety and coupling.
- **Reimplement the LiveSync file/chunk format:** rejected while Commonlib can
  provide compatibility.
- **Wait for upstream Commonlib architecture changes:** rejected as a delivery
  dependency; upstream work is optional optimization.
- **Move/rename the storage Worker now:** deferred because it risks the existing
  Durable Object namespace and configured Obsidian clients.
- **Combine MCP and CouchDB into one Worker:** deferred because independent auth,
  deployment, and rollback boundaries are valuable.
- **Host Commonlib in the MCP Worker over `stub.fetch()`:** considered, since it
  would leave the storage Worker untouched for the whole first release. Kept in
  the Durable Object instead: the vault is single-user, Durable Object storage
  and namespace survive redeploys, one home for vault semantics is simpler, and
  Phase 7 indexing must live beside the database anyway. The remaining exposure
  is shared fate — a defective Commonlib bundle could break the CouchDB
  endpoint — but Cloudflare's deploy pipeline already excludes most of it: a
  failed build uploads nothing, and a script whose global scope fails to start
  is rejected while the previous version keeps serving. What is left is
  request-time defects only, covered by the dry-run, bundle-size, and fixture
  gates before any storage deploy plus one-command `wrangler rollback`.
- **Search/indexing in the first pass:** deferred until logical read/write and
  multi-device propagation are proven.
- **Encryption/path obfuscation in the first pass:** deferred; unsupported
  configurations fail closed rather than being silently weakened.
- **Patch, move, bulk operations, force write, and bulk delete:** deferred until
  guarded whole-file operations have production evidence.

## 13. Definition of initial release complete

The initial release is complete only when:

1. dependencies install reproducibly without sibling repositories;
2. published Commonlib handles the tested vault formats in a Worker;
3. the storage Worker exposes additive semantic status/list/read/write RPC;
4. the MCP Worker implements OAuth 2.1 with GitHub allowlisting and per-tool
   `vault:read`/`vault:write` enforcement;
5. status, list, full/ranged read, create, and guarded update work over MCP;
6. the MCP has no caller-controlled database selector;
7. stale updates cannot overwrite a newer device edit;
8. MCP writes replicate successfully to two Obsidian clients and device edits
   become visible to MCP;
9. existing CouchDB and PouchDB compatibility tests remain green;
10. unsupported encrypted/obfuscated vaults fail closed with a clear status;
11. ChatGPT, Claude, and Grok web compatibility has been tested and documented;
12. production logging, secret rotation, revocation, deployment, and rollback
    procedures are documented and exercised on staging.

## 14. Current external references

- Cloudflare remote MCP server guide:
  <https://developers.cloudflare.com/agents/guides/remote-mcp-server/>
- Cloudflare MCP authorization guide:
  <https://developers.cloudflare.com/agents/guides/remote-mcp-server/#add-authentication>
- Cloudflare Workers OAuth Provider:
  <https://github.com/cloudflare/workers-oauth-provider>
- Cloudflare Durable Object RPC:
  <https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/>
- Model Context Protocol authorization specification:
  <https://modelcontextprotocol.io/specification/latest/basic/authorization>

These links are implementation references, not substitutes for pinned package
versions and repository tests. Recheck their current APIs while implementing each
phase.
