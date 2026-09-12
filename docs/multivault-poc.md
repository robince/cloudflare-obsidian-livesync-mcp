# Multiple vaults in one Durable Object: proof of concept

Status: validated local proof of concept, 11 September 2026. No production code or adapter package
changes. Baseline ee04b47; SQLite adapter 1.1.2-cloudflare-do.0.

## Reproduce

Run `npx vitest run test/multivault-poc.test.ts test/multivault-application-poc.test.ts`
from the repository root.
This requires permission to start local workerd listeners. The test uses the
existing SQLite Durable Object binding with fresh random object IDs. Each
individual test opens multiple PouchDB instances against the SAME state.storage.
No cloud deployment or account credentials are needed.

The test is intentionally not added to package.json yet. Run it explicitly.

## Findings and evidence

The approach is feasible, but table names alone are insufficient for production.
The test-only implementation exercises the installed adapter and unchanged
application methods against real workerd SQLite. It does not release multi-vault
support. Two failure characterizations intentionally assert observed undesirable
behavior: passing them means the defect is reproduced, not fixed.

| Test group | Evidence |
| --- | --- |
| Negative control | Different PouchDB names on unwrapped storage share documents. |
| Physical isolation | Separate table sets preserve identical document IDs, local checkpoints, attachment names/content and independent sequences. |
| Concurrency | Concurrent initialization and writes succeed; eight vaults each receive 50 interleaved writes and contain only their own 50 payloads. |
| Lifecycle | Close/reopen, compaction, destroy/recreate of A leave B readable and writable. Host eviction with open database handles preserves distinct UUIDs and contents. |
| Revision maintenance | Conflicting leaves, tombstones, compaction and purge remain isolated; purging the highest sequence retains the allocation high-water mark, and a later write advances it. |
| Replication | Real PouchDB local replication writes one document, zero on repeat, then one after another source write. Bound payloads equal to table names remain unchanged. |
| Change delivery | Distinct PouchDB names receive only their own change events. Same-name handles in separate namespaces reproduce listener interference when one is destroyed. |
| HTTP handler | Two application `_changes` long polls coexist; A's write completes A while B stays pending. B cancels, times out, and remains writable afterward. Requests go directly to the unchanged handler inside the host DO, not through an external network or production routing. |
| LiveSync and search | Commonlib creates different contents at the same path in two seeded fixture vaults; semantic reads and derived FTS results remain isolated. |
| Backup/restore | Existing R2 backup machinery exports A and restores it into a third namespace, preserving B's note contents and ability to write. |
| Raw transaction failure | A thrown storage transaction rolls back its own row while a concurrent B write survives. |
| Adapter bulk failure | Injecting an exception after a metadata INSERT makes bulkDocs reject, yet both submitted documents remain readable. Characterized with raw storage, scoped storage alone, and scoped storage plus a concurrent neighbour. |

### Multi-vault requirement: independent internal identities

Each database needs a stable internal identity including its storage owner and
vault ID, separate from its public vault name. The adapter's in-memory changes
hub uses the PouchDB name as its key; table prefixes do not isolate that hub.
In the reproducer, A and B use separate SQL namespaces but the same PouchDB name.
Destroying B removes A's existing live listeners. A's data remains intact and an
ordinary changes query still sees subsequent writes. For LiveSync this can delay
notification until a poll times out and reconnects; the test does not demonstrate
data leakage or loss. Distinct-name isolation tests pass.

Use an object-ID-plus-vault-ID internal identity consistently for change listeners,
caches and handle ownership. Test that closing/destroying one owner cannot affect
another, including equal public vault names. The reproducer puts both handles in
one host; it does not require Cloudflare to co-locate separate objects.

### Separate adapter investigation: bulk-write failure handling

The PoC also uncovered ambiguous failure reporting with unnamespaced storage, so
this is not a multi-vault-specific requirement. Track it in a separate issue and
branch: [Bulk-write failure handling investigation](bulk-write-failure-investigation.md).
That document contains the exact reproduction, limitations, investigation steps
and acceptance criteria. It distinguishes per-document bulk failures from a
backend exception; no blanket all-or-nothing bulk-write contract is assumed.

Multi-vault implementation can proceed independently. Before production rollout,
review the investigation's outcome and any required adapter update rather than
bundling an unproven failure-handling fix into the namespace change. The existing
characterization tests remain in the PoC as evidence until ported separately.

### Harness boundaries

`test/multivault-poc/storage.ts` translates a finite list of identifiers and
schema-name literals in the pinned adapter/application SQL. This is not a SQL
parser or security boundary. Do not ship it. Ordinary bound values stay intact;
the exact archive INSERT into sqlite_sequence maps its first binding explicitly,
and the export SELECT converts the physical name to the logical archive name.
Without this exception, backups would contain names incompatible with the
existing archive validator and restores would target the wrong sequence row.

The application harness constructs PouchDatabase with real DurableObjectState,
then injects a scoped context and creates its per-vault metadata table. Native
construction rejects a proxy state. These instances are ordinary JavaScript
application contexts executing inside one actual host object, not separate
Cloudflare objects. Production should extract a plain VaultContext instead.
The host constructor's empty unscoped metadata table remains in this harness.

No production routes, contracts, configuration, package manifest, lockfile or
adapter sources are changed. Separate MCP deployments/OAuth are outside this
storage experiment; the semantic methods they invoke are exercised directly.
No cloud deployment, billing measurement, full device LiveSync session or crash
in the middle of a restore is claimed. These are rollout gates below, not claims
made by a local PoC. The eight-vault test is bounded correctness under contention,
not a production capacity or latency estimate.

## Validation

Run both proof-of-concept files explicitly:

```sh
npx vitest run test/multivault-poc.test.ts test/multivault-application-poc.test.ts
npm run types:check
npm run check
npm run test:all
npm run dry-run
```

Local runs on 11 September 2026: required repository gates passed. The PoC suite
is separately invoked because package.json is unchanged. Runtime/tooling emits
existing dependency sourcemap warnings and a missing-secret warning; the test
configuration supplies its own password binding. No deployment was performed.
Final combined run: **16 tests passed in 2 files**, 3.50 seconds total
(1.47 seconds test execution), using Vitest 4.1.11 and Node 26.8.1. These are
local runner timings, not Cloudflare CPU or billing measurements. Production
`git diff` is empty; all deliverables are new files under test/ and docs/.

## Detailed production implementation plan

### Adapter

Add an optional namespace configuration with empty/default namespace preserving
existing schemas. Resolve all six table names and five named indexes per adapter
instance. Pass the schema descriptor into bulkDocs and helpers instead of using
module-level constants. Scope schema detection, migration, destroy, purge,
compaction and the sqlite_sequence name lookup. Keep document IDs and payloads
unchanged. Test invalid identifiers and default compatibility. Do not use the
proof-of-concept SQL translator as the released implementation.

Define connection identity separately from the public database name, including
object identity and vault identity, for cache and change-listener ownership.
Audit transaction queue and close/destroy lease ownership on shared storage.
Transfer the isolation tests into the adapter repository before publishing.
Port the bulk-failure characterizations in the separate investigation branch.

### Application

Extract VaultContext from PouchDatabase: one PouchDB instance, persisted metadata,
mutation/search queues, maintenance flags and active poll counters per vault.
Pass the immutable context through every awaited operation. Never assign a
mutable current-vault property on the shared object. Poll waits remain outside
mutation queues. Scope every direct SQL query in changes-feed, chunk references
and search; give each vault independent FTS tables and reconciliation state.

Introduce an explicit object-group configuration separate from the vault name.
Keep legacy routing by default. Validate configured vaults before creating tables.
Separate MCP Workers can select a fixed group plus fixed vault from environment;
add a vault argument to internal semantic RPC or a scoped RpcTarget. User-facing
MCP callers must not control this selection. Move shared RPC types into contracts.

### Backup, migration and operations

Preserve per-vault archive semantics. Map physical table identifiers to logical
archive identifiers, including the sqlite_sequence row; restore into a selected
namespace only. Track backup/restore state and write pauses per vault. Never
clear shared storage or drop another vault's tables. Schedule all configured
vaults with explicit per-vault failures and bounded work.

Changing object routing does not migrate data. Provide an explicit copy and
verification procedure with paused writers, backups, checkpoint/UUID policy,
client reset instructions where needed, cutover and rollback. Retain source
objects until verification completes. Document shared throughput, storage,
restart and failure scope, and account-wide request/read/write limits. Verify
actual duration usage in a separately authorized staging deployment; local
runtime timing cannot establish billed GB-seconds.


### Delivery phases and acceptance gates

1. **Define the internal identity contract.** Closing or destroying one storage
   owner must not silence another owner's feed. Test shared and separate storage,
   equal public names, and repeated close/reopen/destroy lifecycles. Keep public
   names stable while adding owner-scoped internal names. Track backend exception
   handling separately in the [adapter investigation](bulk-write-failure-investigation.md);
   its diagnosis and fix are not part of this namespace implementation phase.
2. **Release optional schema namespaces.** Add a schema-name factory and thread
   it through core.js, bulkDocs.js and utils.js (in the adapter source equivalents).
   A namespace must be validated, stable and supplied by trusted code. Include
   index names, sqlite_master predicates and sqlite_sequence predicates. Test
   empty namespace on existing databases; named namespace schema upgrades must
   not alter neighbouring schemas. Expose a typed schema descriptor or sequence
   API so this application does not duplicate adapter internals. Publish only
   after the adapter compatibility and isolation suites pass; upgrade this repository
   in a separate explicit change with a root lockfile update.
3. **Extract contexts and a registry.** Introduce a persisted mapping from public
   vault names to immutable internal IDs. Retain a legacy context for existing
   unprefixed data. Creation, deletion and restore states need persisted lifecycle
   markers; do not recycle IDs while an old context or client can reference them.
   Keep caches and maintenance queues per context. Low-level transactions share
   one physical SQLite database: validate scheduling and rollback across handles;
   if a shared scheduler is needed, keep it bounded to database operations and
   never hold it across a long poll or R2 network wait. Prevent unbounded vault
   creation with a configured allowlist/limit. Report physical database size as
   object-wide; the current HTTP sizes field would otherwise misleadingly look
   like per-vault usage.
4. **Wire routing and MCP together.** Use one consistent resolver for HTTP,
   scheduled backup, manual backup/restore and MCP. Example configuration is
   group `personal` with public vaults `work` and `home`; MCP Workers select one
   fixed vault each. Pass the configured vault explicitly on every semantic RPC.
   Keep auth enforcement at the current Worker boundary, and enforce the
   configured allowlist when selecting contexts. Add tests for invalid/missing
   names, spoofed headers, cursor reuse across vaults and configuration mismatch.
5. **Scope SQL and backups.** Convert direct SQL to descriptor-based names in
   changes-feed.ts, chunk-references.ts, livesync-vault/search.ts and backup code.
   Test identical document/chunk IDs and FTS terms, purge reference checks, aborted
   polls, pending feeds during backup, and A maintenance while B writes. Rebuild
   derived search data after restore. Preserve logical archive table names and
   sequence row names; reject a source manifest intended for another vault.
   Test failed and restarted restores without affecting neighbours. An object-
   wide point-in-time rollback must be documented as affecting every vault.
6. **Migration and staged rollout.** Freeze source writers, export each legacy
   database, import to a fresh group/namespace, verify documents, revision leaves,
   local checkpoints, attachment digests and sequence high-water marks. Existing
   restore deliberately locks the LiveSync milestone and requests a client reset;
   do not promise transparent checkpoint-preserving migration without a separate
   tested procedure. Validate reads/search and fresh replication before routing
   users to the group. Keep verified source backups and a documented rollback
   path; once destination writes occur, rollback requires reconciliation, not
   simply switching the route back. Run two actual LiveSync clients/vaults in
   staging through disconnect/reconnect and a deploy. Measure account DO duration,
   requests, SQLite rows and memory with both vaults polling concurrently for a
   representative period. Keep shared mode opt-in until these gates pass.

### Completion scope

This delivers an isolated executable experiment, evidence for feasibility and
failure cases, and the implementation/rollout plan. It does not claim a production
multi-vault feature or certify arbitrary vault counts. All tests use the pinned
package unchanged. Follow-on package fixes, full HTTP ingress/MCP deployment,
large-vault benchmarks, migration tooling and cloud billing verification are
explicit production work rather than hidden unfinished PoC implementation.
