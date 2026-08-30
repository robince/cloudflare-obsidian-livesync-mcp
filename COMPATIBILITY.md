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
separate deployment where vaults need different trust boundaries. A future MCP
Worker should use a cross-script Durable Object binding rather than storing or
forwarding the CouchDB password.

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
- Mango queries and the dangling-chunk view currently scan all documents inside
  one Durable Object. This is suitable for initial compatibility, but large
  vaults will need purpose-built SQL indexes and pagination work.

## Compatibility evidence

The default test suite covers authentication/CORS, CRUD, attachments, bulk
operations, selector paging, long-poll, continuous Fast Fetch framing,
replication, Mango, the chunk view, purge, and RPC. A separate suite imports the
generated ESM bundles from the local current PouchDB checkout and repeats
selector changes and replication.
