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

## Current surface

Supported tools:

- `vault_status`
- `list_files`
- `search_files`
- `read_file`
- `read_frontmatter`
- `list_attachments`
- `read_attachment`
- `create_file`
- `edit_file`
- `append_file`
- `patch_file`
- `patch_frontmatter`
- `delete_file`

Not supported:

- move, rename, or bulk mutations;
- encryption or path obfuscation;
- attachment writes or attachments larger than the bounded MCP response;
- automatic chunk garbage collection;
- historical LiveSync versions.

All derived Markdown writes require the exact LiveSync revision returned by a
read or successful write. `append_file` appends the supplied text verbatim.
`patch_file` performs an exact replacement and rejects ambiguous matches unless
`replaceAll` is explicitly true. Frontmatter tools operate on top-level YAML
keys while preserving the Markdown body. Listings expose LiveSync metadata
without reading every file body.

`search_files` uses a disposable per-vault FTS5 index. It indexes only the
deterministic winning revision and reports unresolved branch counts without
merging them. Catch-up is on demand from a persisted `_changes` checkpoint;
backlogs and missing chunks return `unavailable` instead of stale results.
Raw Markdown/frontmatter is searched with literal AND terms and BM25 ranking.

## Completed implementation checkpoint — derived vault search

Contract v4 adds read-scoped `search_files` without changing LiveSync's
authoritative documents or replication protocol. The storage Durable Object
owns private `livesync_search_*` tables, validates the PouchDB database identity,
and transactionally couples each derived row replacement or exclusion with its
numeric `_changes` checkpoint. Search schema changes discard and rebuild the
sidecar rather than migrate it.

Each search captures an update-sequence watermark and uses a three-second
budget, checked between documents, while reconciling pages of 100. Once one
winner starts reconstruction it finishes or fails as a unit. Non-metadata
changes advance cheaply. A Markdown winner is reconstructed only when its
revision changed or its FTS row needs repair. Missing chunks stop at that
metadata sequence until replication completes; oversized, over-1,024-chunk,
and permanently unreadable winners advance as explicit exclusions. Purge
removes affected rows and resets the checkpoint, while normal compaction leaves
it intact.

The public query is bounded to 256 UTF-8 bytes and 16 literal terms, defaults
to 20 results, and caps at 50. Results are BM25-ranked across path, title, and
body, tie-broken by path, with 1 KiB snippets and a 128 KiB response ceiling.
Fuzzy search, word prefixes, field queries, pagination, alarms, Cron Triggers,
write-path hooks, and public scores remain deferred pending measured need.

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
- two derived writes from one revision: exactly one winner;
- delete/update race: exactly one winner;
- stale edits and deletes return `conflict`;
- writes are absent and denied when the kill switch is off;
- write authorization requires both scopes and the runtime allowlist;
- the real OAuth provider is exercised in workerd for DCR, PKCE, consent,
  callback replay protection, token exchange, CSRF rejection, and allowlist
  denial;
- authenticated status, list, and read calls run through the real MCP HTTP
  endpoint and a Wrangler-built storage Worker over the configured cross-script
  Durable Object binding;
- one local MCP-to-storage integration covers every advertised tool through
  the real Durable Object RPC boundary;
- existing CouchDB replication tests remain green.

### Gate

Run dependency checks, typechecks, all tests, both Worker dry-runs, and
`git diff --check`. Submit the complete diff and results to independent Terra
reviews for Commonlib/storage and MCP/auth. Fix findings before committing.

Checkpoint commit:

```text
feat: complete guarded livesync writes
```

## Completed implementation checkpoint — LiveSync conflict parity and MCP feedback

Implementation status (2026-09-04, commit `873ea7d`): implemented and reviewed against the pinned
Commonlib conflict specification and Obsidian resolver. Contract v3, structured
MCP errors, conflict-aware reads/listings, bounded pairwise reconciliation, and
CAS race coverage are present. Dependency checks, workspace typechecks, storage /
MCP / OAuth tests, and both Worker builds pass. This is implementation evidence,
not a claim that the disposable two-client staging gate has passed.

### Behavioural contract

Keep the raw CouchDB-compatible surface passive. Replication may store multiple
live revision leaves exactly as it does with a regular CouchDB server; the
storage routes must not silently select, merge, or discard a branch.

The semantic MCP surface distinguishes these outcomes:

| State | MCP behaviour |
| --- | --- |
| The supplied `expectedRevision` is no longer current and no revision-tree conflict needs human resolution | Fail with `revision_conflict`; instruct the caller to reread, reconsider the operation against the new content, and retry only if still appropriate. |
| A path has multiple live leaves and Commonlib can conservatively resolve the next pair | A write-authorized operation may commit that resolution, but must not replay the caller's original mutation. Return `conflict_reconciled` and require a reread. |
| A path has multiple live leaves and Commonlib cannot resolve them conservatively | Make no change and fail with `livesync_conflict`, identifying the path and version count and directing the user to resolve it in a full Obsidian Self-hosted LiveSync client. |
| A read-only operation encounters multiple live leaves | Make no change and fail with `livesync_conflict`; a read must never mutate the revision tree or present PouchDB's deterministic winner as the unqualified Vault file. |

`livesync_conflict` is not retryable until an Obsidian client resolves and
replicates the file. `revision_conflict` and `conflict_reconciled` require a
fresh read before any retry. The MCP error text must be useful when passed
directly to a human, and its structured fields must let a client distinguish
the three cases without parsing prose.

This checkpoint does not add human conflict-selection tools, background
server-side conflict resolution, attachment writes, newer-file binary policy,
search, FTS5, R2, or large-attachment transport. Those concerns must not be
pulled into either checkpoint below.

### Contract and MCP layer

1. Bump the semantic contract version and replace the overloaded `conflict`
   result with explicit `revision_conflict`, `conflict_reconciled`, and
   `livesync_conflict` variants.
2. Give conflict errors structured fields appropriate to their type, including
   `path`, `resolution`, and, for unresolved LiveSync branches,
   `unresolvedVersions`. Do not return branch bodies or suggest that a current
   revision token is a substitute for rereading the file.
3. Preserve the structured error in MCP `structuredContent` while also setting
   `isError: true` and returning a direct human-readable message. Validate the
   result shape through the real MCP client, not only the storage RPC.
4. Update mutation tool descriptions to require a reread and reassessment after
   `revision_conflict` or `conflict_reconciled`. Do not describe automatic
   blind retry as safe.
5. Keep authorization ahead of storage access. A read-only caller, a denied
   caller, or a deployment with `MCP_WRITES_ENABLED=false` must never trigger
   or observe the side effects of conflict resolution.

### Commonlib and storage layer

1. Extend the pinned Commonlib facade with conflict-aware metadata reads using
   `{ conflicts: true, revs_info: true }`. Inspect conflict state before
   interpreting the winning leaf as deleted, missing, Markdown, or binary.
2. Return conflict state with ordinary bounded metadata so `list_files` and
   `list_attachments` can flag affected paths. Use bounded per-page lookups if
   Commonlib enumeration cannot request `_conflicts`; record the performance
   cost rather than broadening the raw CouchDB API.
3. Use Commonlib 0.1.19's `LiveSyncLocalDB.tryAutoMerge(path, true)` as the
   merge classifier and content generator. Do not copy or independently modify
   its three-way Markdown or structured-object merge algorithm.
4. Reproduce only the host operations needed to commit Commonlib's safe result:
   write merged content as a child of the exact observed winning leaf, then
   delete only the exact observed losing leaf. Collapse byte-identical leaves
   using LiveSync's deterministic pair policy. Reinspect the tree after every
   step.
5. Process three or more live leaves one observed pair at a time, as LiveSync
   does. Bound the number of pairs handled in one RPC; if the tree changes or
   the bound is reached, preserve every remaining leaf and require a later
   retry or Obsidian resolution.
6. Treat overlapping Markdown edits, delete-versus-modify, unrelated roots,
   missing history, missing chunks, and any unreadable leaf as
   `livesync_conflict`. Do not guess a merge base or delete a branch because it
   cannot be read.
7. Do not implement the Obsidian host's newer-mtime policy for binary files in
   MCP. The MCP has no attachment writes or device-local host policy; report
   the conflict and let Obsidian resolve it. Do not enable the broader
   `resolveConflictsByNewerFile` policy, which is device-local.
8. Run automatic resolution only after write authorization and before an MCP
   mutation. If it changes the tree, return `conflict_reconciled` without
   applying the original mutation. A subsequent reread supplies the only valid
   base for that mutation.
9. Keep ordinary PouchDB revision CAS as the final commit boundary. Do not add
   a request-wide Durable Object lock or use a forced put. A stale observed
   pair must be re-read, never applied to a changed tree.

### Required hermetic tests

- stale update, derived write, and delete return `revision_conflict`, create no
  branch, and tell the caller to reread and reassess;
- a read of a pre-conflicted Markdown path returns `livesync_conflict`, reports
  the number of live versions, and leaves every revision unchanged;
- file and attachment listings flag pre-conflicted paths without returning a
  branch body;
- non-overlapping Markdown branches use Commonlib's result, leave one live
  version, do not apply the triggering MCP mutation, and return
  `conflict_reconciled`;
- identical branches collapse without synthesising different content;
- overlapping Markdown changes, delete-versus-modify, independent roots,
  missing merge ancestry, and missing chunks remain byte-for-byte and
  revision-for-revision intact and return `livesync_conflict`;
- three or more branches are processed in Commonlib's deterministic pair order
  and stop without touching the first manual pair;
- a branch changed concurrently with automatic resolution is not deleted and
  the operation refreshes or fails closed;
- a conflicted binary attachment is not resolved by MCP and directs the user
  to Obsidian;
- read-only OAuth, a disabled write switch, and failed authorization cannot
  trigger resolution;
- MCP error results retain their structured conflict code, path, version count,
  resolution route, and human-facing instructions through the real HTTP MCP
  endpoint;
- existing concurrent-write, CouchDB replication, OAuth, and tool-surface tests
  remain green.

### Documentation and gate

Document the distinction between a rejected stale write and an existing
LiveSync revision-tree conflict in `COMPATIBILITY.md`, the MCP README, and
`docs/residual-issues.md`. State that the deterministic PouchDB winner may not
be the version displayed by an Obsidian device while conflicts remain.

Run dependency checks, typechecks, all tests, both Worker dry-runs, and
`git diff --check`. Review the final diff specifically against the pinned
Commonlib conflict specification and LiveSync 1.0.21's resolver before the
checkpoint is committed.

Checkpoint commit:

```text
feat: surface and safely reconcile livesync conflicts
```

## Completed checkpoint — disposable-vault conflict staging

Execution status (2026-09-04): separate uniquely named storage and write-disabled
MCP Workers have been provisioned, with an independent Durable Object namespace
and OAuth KV. Existing production/manual-test deployments were not changed.
Deployment identifiers and credentials are retained only in ignored local files.
The pinned client worktree builds and staging preflight passes. Two independent
real Obsidian sessions load LiveSync 1.0.21 successfully. A separate disposable
database passed a real A-to-B-to-A replication round-trip through the new remote
storage Worker. The current Obsidian external-link confirmation is handled only
for the exact generated test-vault path, without disabling future prompts.
The full authenticated eight-case conflict matrix now passes, including actual
Obsidian dialogue resolution and binary-host policy. Kill-switch file reads,
write-token revocation (HTTP 401), and real replication after staging-only MCP
and storage rollbacks also pass. Fresh read-only consent after revocation passes
with the write switch enabled (scope denial, no mutation); MCP is restored
write-disabled. See `docs/conflict-staging-results.md` for the execution record
and `docs/conflict-staging.md` for the runbook.

### Preparation

1. Use a disposable remote database and two isolated Obsidian vaults running
   the pinned Self-hosted LiveSync client. Back up both local vaults before
   deliberately creating conflicts.
2. Deploy the additive storage RPC, initially deploy MCP with
   `MCP_WRITES_ENABLED=false`, and verify that ordinary replication and MCP
   status/list/read behaviour are unchanged.
3. Enable writes only for the allowlisted staging account. Keep a tested
   MCP-only rollback and the write kill switch available throughout the run.

### Validation matrix

1. Confirm normal MCP create, edit, derived write, and delete propagation to
   both Obsidian clients.
2. Make two offline non-overlapping Markdown edits, replicate both branches,
   and verify that a write-authorized MCP operation commits Commonlib's safe
   merge, returns `conflict_reconciled`, and does not apply its requested edit.
   After rereading, retry deliberately and confirm convergence to one version.
3. Create overlapping Markdown edits and verify that MCP reads and writes fail
   with `livesync_conflict`, no branch changes, and instructions to use
   Obsidian. Resolve through the normal Obsidian dialogue, allow the resolution
   to replicate, then confirm MCP can reread and continue.
4. Repeat the manual path for delete-versus-modify and for two different files
   independently created at the same path.
5. Create byte-identical branches and verify safe collapse without a human
   prompt or content change.
6. Create three live Markdown versions and confirm pairwise ordering, partial
   automatic progress, and preservation of the remaining manual pair.
7. Create differing revisions of one ordinary image attachment. Verify that
   MCP reports the conflict without changing it, then that a full Obsidian
   client applies its normal binary conflict policy and replicates the result.
8. Exercise a stale MCP revision separately and verify that its feedback says
   to reread and reassess, without claiming that Obsidian resolution is needed.
9. Recheck write-switch disablement, token revocation, storage/MCP rollback,
   and normal replication after every conflict class has converged.

### Evidence and exit criteria

Record sanitized revision-tree shapes, MCP structured results, Obsidian notices
or dialogue outcomes, and final convergence counts. Do not commit vault names,
content, account identifiers, OAuth credentials, URLs, or secrets.

The checkpoint passes only when:

- safe Commonlib merges converge to one live version and never replay the
  triggering MCP mutation;
- every manual conflict remains unchanged until resolved in Obsidian;
- MCP always distinguishes stale CAS from unresolved LiveSync branches;
- the user-facing MCP message gives the correct recovery route;
- both Obsidian clients converge after resolution; and
- disabling or rolling back MCP leaves ordinary LiveSync replication healthy.

This checkpoint pauses for deployment credentials and interactive client
access. It receives a separate review and commit from the implementation
checkpoint.

## Commit discipline

- Review and test each checkpoint before its atomic commit.
- Do not amend, squash, rebase, or rewrite approved checkpoint commits.
- Do not mix unrelated user changes into a checkpoint.
- Production identifiers and secrets are supplied out of band and never
  committed.
