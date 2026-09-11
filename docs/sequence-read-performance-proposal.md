# Proposal: avoid document recounts when reading the change sequence

Status: implemented locally 11 September 2026; diagnosis and read reduction
confirmed in workerd (see "Implementation results"). No deployment performed.

Prepared: 11 September 2026. Source reviewed: commit
`ee04b472b078fa305b91a405b9491dfdc16f9900`, with installed SQLite adapter version
`1.1.2-cloudflare-do.0`.

This concerns the CouchDB-compatible sync server (`src/pouch-database.ts` and
`src/changes-feed.ts`), which the Obsidian Self-hosted LiveSync plugin polls
directly. The vault/MCP layer in `src/livesync-vault/` is affected only through
the single `db.info()` call in search.

## Implementation results

`readUpdateSequence()` now waits for `db.id()` and reads the pinned adapter's
`sqlite_sequence` entry directly. Changes-feed snapshots, `since=now`, and the
search catch-up target use it. Database-info and backup/restore initialization
calls remain unchanged. There is no schema migration or sequence cache.

The permanent `test/sequence-read.test.ts` suite is included in `npm test` and
the adapter-upgrade checks in `COMPATIBILITY.md`. Workerd measurements on
11 September 2026, with adapter `1.1.2-cloudflare-do.0`, were:

| Live documents | Document count reads | Helper reads | Empty poll with old recounts | Empty poll after fix | Empty poll since=now |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 20 | 1 | 48 | 8 | 9 |
| 100 | 200 | 1 | 408 | 8 | 9 |
| 1,000 | 2,000 | 1 | 4,008 | 8 | 9 |

The baseline column reproduces the old count SQL at each sequence snapshot in
the otherwise identical complete poll; the earlier pre-change measurements
below independently reported the same totals. Measurements exclude seeding and
warm-up, consume the HTTP response, and sum cursor `rowsRead` after consumption.
The helper issues only its sequence query after warm-up. Cold adapter creation
plus its first helper read on a fresh object consumed 20 rows, measured separately
from steady-state polling. Query-plan assertions confirm the document-count scan
and the indexed change-candidate lookup. Instrumentation is test-only and restored
in `finally`; no production SQL logging was added.

Regressions cover invalid sequence values and failures, concurrent writes,
replicated conflicts, deletion, compaction, purge of the latest allocated
revision, backup/restore and real Durable Object eviction/reconstruction.
Long-poll race tests use a timeout longer than the test deadline so missing a
listener wake-up cannot pass by finding the write after timeout. Existing search
catch-up and cursor tests run unchanged except for an additional assertion that
a reused search index does not call `db.info()`.

Validation passed: `npm run types:check`, `npm run check`, `npm run test:all`,
and `npm run dry-run`. The dedicated sequence suite contains 11 passing tests;
both Workers bundle successfully without deployment.

Production savings still require deployment and a matched full-UTC-day
observation period as described under "Deployment validation".

## Problem and measured impact

The deployed LiveSync service consumes millions of SQLite row reads per day even
when very few rows are written. This reduces free-tier headroom and could make
read usage grow with both vault size and the number of connected clients.

Cloudflare analytics were collected from the latest storage deployment on
6 September 2026 at 10:14:40 UTC through 11 September at 00:00 UTC. The table below
uses only complete UTC days. These are account-wide totals; usage outside the
production storage namespace was negligible during this window.

| UTC date | SQLite rows read | SQLite rows written | DO requests | Read allowance used |
| --- | ---: | ---: | ---: | ---: |
| 7 September | 1,981,237 | 1,494 | 4,543 | 39.6% |
| 8 September | 2,648,659 | 6 | 3,527 | 53.0% |
| 9 September | 2,636,548 | 9 | 3,512 | 52.7% |
| 10 September | 2,713,912 | 161 | 3,639 | 54.3% |

The free SQLite read allowance is 5 million rows per day, resetting at midnight
UTC. On 10 September, the ratio was approximately 746 rows read per DO request.
This is an aggregate ratio, not a measured per-long-poll cost: requests also
include other HTTP operations, RPC and background activity.

Sources were `durableObjectsPeriodicGroups.sum.rowsRead/rowsWritten` and
`durableObjectsInvocationsAdaptiveGroups.sum.requests`. Platform sampling and
ingestion caveats apply. Historical application logs were inaccessible with the
available credential, so endpoint counts and per-query attribution are unknown.
No vault content was fetched for this analysis.

## Likely cause

The application requests full PouchDB database information where it only needs
the current update sequence:

```ts
const target = Number((await db.info()).update_seq);
```

This occurs in `src/changes-feed.ts`, at the start of `changesFeed()`.
The pinned SQLite adapter's `lib/core.js` implements `_info()` by running both
`getMaxSeq()` and `countDocs()` on every call. There is no document-count cache
in that implementation.

The sequence lookup is small:

```sql
SELECT seq FROM sqlite_sequence WHERE name='by-sequence';
```

The document count joins `document-store` to the winning revision in
`by-sequence` and counts non-deleted documents. It must examine stored rows to
compute the count even though the caller discards that result. Returning a
single aggregate value does not imply a single billed row read.

An idle long-poll follows this path in `src/pouch-database.ts`:

1. Call `changesFeed()` to check for existing changes, including `db.info()`.
2. If empty, register a live PouchDB change listener and wait for a change or
   timeout (25 seconds by default, capped at 55 seconds).
3. Call `changesFeed()` again after the wait, including another `db.info()`.
4. Return the result; a continuously syncing client can issue the next poll.

Consequently, an empty completed long-poll performs two unnecessary document
counts. Requests with `since=now` perform an additional `db.info()` in
`changesRoute()`. Search also calls `db.info()` to capture its index catch-up
target in `src/livesync-vault/search.ts`.

Measured in workerd (see below), the count reads two rows per live document:
`SCAN document-store` plus one primary-key probe into `by-sequence` per row.
An empty long-poll therefore reads 4 × live documents + 8 rows. Every other
query on the idle path reads at most one row.

The production request rate of roughly 3,500 DO requests per day is almost
exactly one 25-second long-poll at a time from a single continuously connected
client (86,400 / 25 = 3,456). At about 760 rows per request that implies a vault
of roughly 190 live documents, which is plausible, so the count explains
essentially all of the observed idle reads.

Other contributors include actual replication, database-info requests,
`allDocs()` counts, search catch-up and backup scans. The `max_seq INTEGER
UNIQUE` column creates `sqlite_autoindex_document-store_2`, and `EXPLAIN QUERY
PLAN` confirms the candidate, pending and live-listener queries all use it, so
a missing sequence index is not the explanation.

## Measured cost

Measured on 11 September 2026 with `@cloudflare/vitest-plugin` (workerd) and
the pinned adapter, using a throwaway test that seeded a database through
`_bulk_docs`, ran each query through `storage.sql.exec` and read the consumed
cursor's `rowsRead`, then wrapped `storage.sql.exec` to sum `rowsRead` across
one complete empty long-poll (`feed=longpoll&since=<current>&timeout=200`).

| Live documents | `countDocs()` | sequence lookup | listener registration | candidates page | pending count | whole empty long-poll |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 20 | 1 | 1 | 1 | 1 | 48 |
| 100 | 200 | 1 | 1 | 1 | 1 | 408 |
| 1,000 | 2,000 | 1 | 1 | 1 | 1 | 4,008 |
| 300, four revisions each | 600 | 1 | 1 | 1 | 1 | 1,208 |

Query plans:

- Count: `SCAN document-store`, then `SEARCH by-sequence USING INTEGER PRIMARY
  KEY (rowid=?)`. Cost scales with live documents, not with stored revisions.
- Live listener and candidates: `SEARCH document-store USING INDEX
  sqlite_autoindex_document-store_2 (max_seq>?)`, then the same primary-key
  probe. Cost is constant when nothing has changed.

The eight fixed rows per empty poll are: three `cloudflare_pouchdb_meta`
lookups from this repository's existence checks, two sequence lookups, two
candidate pages, two pending counts and one listener registration query, of
which several return zero rows. The live listener issues its query once at
registration and never again while nothing is written.

After the fix an empty long-poll should read about 8 rows regardless of vault
size. At the current poll rate that is roughly 30,000 rows per day from
polling, against about 2.6 million today, leaving real replication, the
database-info route and search catch-up as the remaining costs.

## Proposed fix

Add one adapter-specific helper that reads the persisted sequence without
calculating the document count. Place it in `src/changes-feed.ts`, which
already owns direct SQL access to the adapter's schema and documents that
coupling, rather than in a new file.

Illustrative implementation:

```ts
export async function readUpdateSequence(
  db: PouchDB.Database,
  sql: SqlStorage,
): Promise<number> {
  // Public PouchDB methods wait for asynchronous adapter initialization.
  // In the pinned adapter, _id returns the initialized in-memory identity.
  await db.id();

  const rows = sql.exec<{ seq: number }>(
    "SELECT seq FROM sqlite_sequence WHERE name='by-sequence'",
  ).toArray();
  if (rows.length > 1) throw new Error('Invalid database update sequence');
  const seq = rows[0]?.seq ?? 0;
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new Error('Invalid database update sequence');
  }
  return seq;
}
```

This is a design sketch, not compiled code. Match the project's database typing
and error handling during implementation. Confirm the readiness barrier and
transaction interaction in workerd tests, including cold initialization and
concurrent writes. Do not assume that constructing a PouchDB instance means its
SQLite schema has already been created.

Replace only sequence-only calls:

| Location | Change |
| --- | --- |
| `src/changes-feed.ts`, `changesFeed()` | Capture `target` using the helper. |
| `src/pouch-database.ts`, `changesRoute()` | Resolve `since=now` using the helper. |
| `src/livesync-vault/search.ts`, `search()` | Capture the catch-up target using the helper. |

Retain `db.info()` where database information, including `doc_count`, is actually
required, and leave the adapter's `_info()` untouched so the database-info route
and PouchDB replication start-up still return an accurate `doc_count`. Leave
backup/restore initialization calls unchanged in this patch.
Continue using PouchDB for revision trees, conflict resolution and changes
construction. No schema migration, new persistent counter, timer or deployment
configuration should be needed.

### Readiness barrier

`await db.id()` is a sufficient readiness barrier. In `pouchdb-core`, `id()` is
wrapped by `adapterFun`, which queues the call until the task queue is ready.
The pinned adapter calls the ready callback only after `initialize()` resolves,
and `initialize()` awaits `setup()`, which runs `fetchVersion()` and therefore
`createInitialSchema()` or `runMigrations()` inside the transaction queue. So
once `id()` resolves, the tables and `sqlite_sequence` exist. `search()` in
`src/livesync-vault/search.ts` already relies on this pattern before running its
own SQL. The subsequent synchronous `sql.exec` runs outside the adapter's
transaction queue, which is what `changesFeed()` already does for its candidate
and pending queries, so no new ordering assumption is introduced.

### Sequence semantics and concurrency

Use precisely the adapter's `sqlite_sequence` source. Do not substitute
`MAX(seq)` from surviving revision rows or `MAX(max_seq)` from documents: purge
or compaction can remove rows while the persisted allocation high-water mark
remains higher. The backup implementation already preserves this sequence.

Return zero for an initialized empty database with no sequence entry. Missing
schema or SQL failures must propagate rather than silently becoming zero.
Do not cache the sequence across requests or across the long-poll wait; writes,
restore and object lifecycle changes must remain visible.

Preserve separate sequence snapshots before and after waiting, and retain the
live listener's `since` value so a write between the first check and listener
registration is still discovered. Do not change `last_seq`, `pending`, filtering,
descending traversal, timeout or cancellation behavior as part of this fix.

## Alternatives

- **Adapter-level sequence-only API:** a cleaner abstraction if maintained
  upstream, but requires an adapter release and integration. A local helper is
  smaller and consistent with existing direct SQL access in changes and backup.
- **Cache or maintain `doc_count`:** can improve real info requests too, but
  requires correct invalidation across replication, deletes, purge and restore.
  It introduces more correctness risk than avoiding an unwanted calculation.
- **Reduce poll frequency or change sync mode:** may reduce reads and duration,
  but changes client behavior. This proposal removes server-side work while
  preserving the current sync mode.

## Validation and acceptance criteria

### Confirm the diagnosis and read reduction

Use disposable SQLite Durable Objects with synthetic datasets of increasing
size, for example 10, 100 and 1,000 documents. Warm adapter initialization before
steady-state measurements and measure cold initialization separately.

Record consumed SQL cursor `rowsRead` values for the old count and sequence
queries and the proposed helper; use test-only query instrumentation where
needed. Inspect query plans to distinguish scans from indexed lookups. Also
measure complete empty long-polls before and after the change, so other costs
are visible. Avoid permanently enabling SQL logging or logging document values.

Acceptance: the sequence-only operation no longer performs document-count SQL,
and its row reads do not grow with document count for a fixed schema. End-to-end
empty-poll reads must fall from 4 × documents + 8 to a small constant; if they
still grow with vault size, identify the remaining query rather than attributing
all reads to this fix.

Add a permanent regression test: seed 1,000 documents through `_bulk_docs`,
use `runInDurableObject` to wrap `instance['ctx'].storage.sql.exec` so it sums
the consumed cursor's `rowsRead`, run one empty long-poll against the current
sequence, and assert the total is below 20. Include this test in the
adapter-upgrade checks, since it is the strongest guard against a future
adapter version reintroducing a count on this path.

Testing note: `console.log` inside tests did not reach vitest output under the
workers pool with the current configuration, so measurement tests should assert
on values rather than print them.

### Correctness regression coverage

- Compare helper results with `db.info().update_seq` for empty databases,
  ordinary writes, replication with `new_edits:false`, conflicts and deletions.
- Verify sequence behavior after compaction, purge of the latest revision,
  backup/restore and cold object reconstruction.
- Exercise normal and descending changes, limits, selectors, document-ID
  filters, `since=now` and `since` beyond the current sequence.
- Exercise empty-poll timeout, client cancellation and writes before listener
  registration and during the wait; assert no missed changes or hanging polls.
- Verify search catch-up and cursor behavior, plus unchanged database-info
  document counts.

Run the repository's required checks: `npm run types:check`, `npm run check`,
`npm run test:all` and `npm run dry-run`.

### Deployment validation

After implementation and release review, compare matched observation periods
with similar vault contents, connected clients and sync settings. Report daily
row reads, requests and DO duration, separating initial imports and backup work.
Use at least a full UTC day for quota comparisons. Without endpoint telemetry,
rows per DO request remains a coarse indicator rather than a per-poll metric.

Expected outcome: idle polling reads fall from about 4 × documents + 8 rows per
poll to about 8, roughly 30,000 rows per day at the current single-client poll
rate. A specific production figure still depends on replication, info and
search activity and should be confirmed after deployment. Rollback requires restoring the previous Worker version; the proposal
does not change stored schema or data format.

## Scope and remaining limits

This addresses SQLite reads only. Pending HTTP long-polls still keep the Durable
Object active; removing a count will not remove its wall-clock duration usage.
Two similarly active vaults in separate objects would still exceed the current
free duration allowance. Sharing an object is a separate architectural proposal.

The principal maintenance risk is coupling to the pinned adapter's internal
sequence representation. Document that dependency beside the helper and include
sequence-equivalence tests in adapter-upgrade checks.

## Review questions and answers

1. **Local helper or adapter API?** A local helper in `src/changes-feed.ts` is
   acceptable and consistent with the existing direct SQL there. Because the
   adapter is our own fork, it can be promoted to an adapter API later without
   blocking this fix.
2. **Does `await db.id()` preserve readiness and ordering?** Yes; see
   "Readiness barrier". The write-ordering situation is unchanged from today,
   where `db.info()` provided the same barrier before the same direct SQL.
3. **Do the measurements establish cause and savings?** Yes; see "Measured
   cost". The live change listener reads one row at registration and nothing
   during the wait, so it is not a hidden contributor.

## References

- [Cloudflare Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [SQLite cursor row-read metering](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- Repository: `src/changes-feed.ts`, `src/pouch-database.ts`,
  `src/livesync-vault/search.ts`, `src/backup/storage.ts` and
  `docs/support-diagnostics.md`.
- Installed adapter: `node_modules/pouchdb-adapter-sqlite-core/lib/core.js`,
  functions `getMaxSeq()`, `countDocs()` and `_info()`; package alias resolves to
  `@robince/pouchdb-adapter-sqlite-core@1.1.2-cloudflare-do.0`.
- Installed PouchDB: `node_modules/pouchdb-core/lib/index.es.js`, `id()` uses
  `adapterFun`, which gates calls on adapter readiness.
