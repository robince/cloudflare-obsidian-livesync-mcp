# Compatibility and limits

## Obsidian LiveSync coverage

| LiveSync operation | Endpoint | Status |
| --- | --- | --- |
| setup and connectivity | `/`, database `PUT`/`GET`, `_session`, `_up` | Implemented |
| setup configuration audit | `/_node/_local/_config` | Emulated, read-only values |
| ordinary replication | `_changes`, `_revs_diff`, `_bulk_get`, `_bulk_docs` | Implemented and replication-tested |
| live replication | `_changes?feed=longpoll` | Implemented and tested from `since=now` |
| Fast Fetch | `_changes?feed=continuous` | Implemented as a bounded newline-delimited page |
| on-demand selector replication | `_changes` with `_selector` | Implemented for LiveSync selectors |
| compromised chunk checks | `_find` | Implemented for the comparison operators LiveSync uses |
| dangling chunk collection | `_design/chunks/_view/collectDangling` | Implemented for the LiveSync design document |
| remote chunk purge | `_purge` | Implemented |
| checkpointing | `_local/*` documents | Implemented by the PouchDB core |
| compaction | `_compact` | Implemented |

The tests exercise PouchDB's real HTTP adapter and replicator. They are not
mocked route-unit tests. The current LiveSync repositories were also audited for
their selectors, maintenance view, purge payload, configuration checks, and
Fast Fetch framing.

## Deliberate scope

The service does not currently provide arbitrary JavaScript map/reduce views,
the full Mango query language or persistent indexes, CouchDB clustering,
partitioned databases, `_security`, database enumeration, JWT authentication,
or CouchDB's administrator/configuration mutation model. `_index` is accepted
for PouchDB compatibility, but query execution is an in-object scan.

Only the finite, limited continuous feed used by LiveSync Fast Fetch is
implemented. Normal PouchDB live replication uses long-poll and is supported.

Authentication is one deployment-wide Basic username/password pair. Use a
separate deployment where vaults need different trust boundaries. The MCP Worker uses a cross-script Durable Object binding rather than storing or
forwarding the CouchDB password. Basic authentication is deliberately a single
trust boundary across the deployment, not per-vault tenant authorization.

## Cloudflare constraints

- A database is one SQLite-backed Durable Object. It therefore has the normal
  single-object throughput and storage characteristics.
- Durable Object SQL limits an individual string or BLOB to 2 MB. The service
  applies conservative 1.8 MB document and 900 KB attachment limits.
- LiveSync's default approximately 100 KB chunks are safe. Do not apply large
  custom chunk sizes copied from a conventional CouchDB deployment.
- The CouchDB configuration response reports the values expected by LiveSync's
  CouchDB setup audit. Those compatibility values cannot alter Cloudflare's
  platform limits.
- Mango queries remain scans. Chunk maintenance scans retained revision bodies
  in bounded batches with a fail-closed budget; large histories may exceed it.

## Semantic MCP search (contract version 5)

Each vault Durable Object keeps a private FTS5 index derived from the
authoritative LiveSync revision tree. `search_files` catches it up from the
persisted PouchDB `_changes` sequence on demand, in pages of 100 with a
three-second budget checked between documents. A backlog or a metadata winner
whose chunks have not replicated returns `unavailable`; stale or partially
reconstructed results are never returned. A permanently orphaned chunk
therefore blocks vault search until the LiveSync data is repaired. Compaction
preserves the checkpoint. Purge resets reconciliation, and a changed PouchDB
database identity clears and rebuilds all search state.

Only the deterministic current winner is indexed. Search never performs CAS,
conflict resolution, or authoritative writes; conflicted hits report
`unresolvedVersions`. Path, title, and raw Markdown (including YAML
frontmatter) use Unicode tokenization, diacritic removal, and BM25 ranking.
Query terms are escaped literal text with implicit AND. Fuzzy and prefix-word
matching are intentionally deferred. Winners over 512,000 bytes, winners with
more than 1,024 referenced chunks, or permanently unreadable winners are
excluded and counted as vault-wide incomplete index coverage.

## Semantic MCP conflicts

Raw CouchDB replication remains passive: it retains divergent live leaves.
The deterministic PouchDB winner is not necessarily the version displayed by
an Obsidian device. MCP reads fail with `livesync_conflict` instead of silently
returning that winner. Listings flag affected paths with `unresolvedVersions`.

Ordinary stale writes return `revision_conflict`: reread, reassess the intended
change, and retry only if appropriate. No forced revision branch is created.
After write authorization, existing conflicts may be reconciled using pinned
Commonlib 0.1.19's `tryAutoMerge(path, true)`. A safe result is committed with
ordinary revision CAS, followed by removal of only the observed losing leaf.
Duplicate bytes use the pinned Obsidian host's duplicate-selection policy.
Any progress returns `conflict_reconciled`; the triggering mutation is never
replayed. A fresh read is required before the caller tries again.

Unsafe/unreadable conflicts return `livesync_conflict` with the file path,
version count, and instructions to resolve through a full Obsidian Self-hosted
LiveSync client and sync the result. Reads never merge. MCP does not implement
the host's newer-mtime binary policy or provide human-selection tools.

The resolver is conservative: at most eight pairs per RPC, sixteen live leaves,
and 512,000 decoded bytes/1,024 chunks per required body. Exceeding these bounds
preserves remaining leaves and directs the caller to Obsidian. Revision CAS
protects each commit, not an atomic transaction over the complete revision tree;
concurrent replication can introduce another conflict at any time.

## Automated compatibility evidence

The default test suite covers authentication/CORS, CRUD, attachments, bulk
operations, selector paging, long-poll, continuous Fast Fetch framing,
replication, Mango, the chunk view, purge, and RPC. A separate suite imports the
generated ESM bundles from the local current PouchDB checkout and repeats
selector changes and replication.

## Replication and maintenance safety (contract 5 checkpoint)

`_changes` scans bounded batches of 16 candidates from the pinned PouchDB
adapter's indexed sequence table. Normal unlimited responses stream to their
captured feed watermark; no implicit result cap is introduced. Long-poll and
finite continuous feeds remain supported. Filtering advances past excluded rows
without skipping unreturned matches. `pending` counts remaining underlying feed
documents, not exact filtered matches. `style=all_docs` selects matching leaf
revision IDs while `include_docs` returns the winner. Unsupported selector
operators fail explicitly. `open_revs=all` and revision arrays are validated;
`limit=0` means one, and negative/fractional/malformed limits return HTTP 400.
The read-only adapter-table dependency is covered by replication regressions
and must be reviewed when upgrading the pinned adapter.

The dangling-chunk view and `_purge` inspect all retained available revision
bodies, including losing leaves, readable ancestors and deletion records.
Resolution alone does not release chunks still referenced by retained history.
An unavailable unresolved leaf fails closed; compacted unavailable ancestor
bodies are no longer recoverable and do not protect former references.
Purge rechecks references under the per-vault mutation gate and rejects the
entire requested chunk batch if referenced or safety cannot be established.
Checks use bounded batches and a 20,000 document/revision, three-second budget;
`maintenance_unavailable` requires reducing retained history deliberately or
reviewing maintenance limits, not bypassing validation. Purge batches are capped
at 100 documents and 100 requested revisions per document.

**Complete replication and pause all writers before maintenance.** The server
cannot see metadata still on a disconnected client or between separate raw
replication requests. Active semantic writes block purge; raw authoritative
mutations serialize with validation/deletion. Commonlib operations do not hold
that gate around their entire operation, avoiding re-entrant deadlocks. There is
no automatic cleanup. Compaction deliberately sacrifices readable historical
bodies; conflict resolution and compaction are distinct retention decisions.

The semantic contract is version 5. Only disposable derived-index tables are
rebuilt during schema migration; the authoritative namespace, revisions and
replication checkpoints are preserved. Search content, normalized properties,
conflict metadata and index checkpoint update transactionally. Persisted cursor
generations survive object restart and change on indexed mutations or rebuilds.
See the [MCP interface](apps/cloudflare-obsidian-mcp/README.md) for query typing,
pagination and bounded outline semantics.

Descending `_changes` pages use a positive `since` as an exclusive upper
sequence bound; omitted/zero starts from the newest sequence. This deliberately
supports resumable reverse pages despite the pinned PouchDB API ignoring
`since` in descending mode. On an exhausted page, `last_seq` retains the caller
checkpoint. Empty notes support full reads and empty outlines, but have no
valid inclusive line range; ranged reads return `invalid_input`.
