# Adapter bulk-write failure handling investigation

Status: reproduced locally; root cause and intended failure contract need
investigation. No adapter fix, package change, separate branch or upstream issue
has been created by this documentation change.

Discovered during the [multi-vault PoC](multivault-poc.md), but reproducible without
SQL namespacing or concurrent neighbour writes. Handle this as a separate adapter
issue/branch, not as part of adding multi-vault namespaces.

## Observed behavior

On baseline application commit `ee04b47`, using
`@robince/pouchdb-adapter-cloudflare-do@1.1.2-cloudflare-do.0` and
`@robince/pouchdb-adapter-sqlite-core@1.1.2-cloudflare-do.0`, a workerd test:

1. Opens a fresh PouchDB database and completes initialization.
2. Submits `bulkDocs([{ _id: 'failed1' }, { _id: 'failed2' }])`.
3. Wraps SQL execution and, once armed, allows the first matching
   `INSERT INTO 'document-store'` statement to execute, then throws
   `Error('injected after document insert')` before returning its cursor.
4. Observes the bulkDocs Promise reject.
5. Queries allDocs and info: both IDs are present and doc_count is 2.
6. Successfully writes another document afterward.

The same assertions pass in three modes: unnamespaced storage, namespaced
storage, and namespaced storage with a concurrent write to a neighbouring vault.
In the concurrent case, the neighbour's write succeeds and remains readable.

A separate lower-level test throws from a storage.transaction callback after
inserting a local-store row. That row rolls back while a neighbour's write
survives. This is evidence that the simple storage transaction case works; it
cannot establish correct adapter error propagation through bulkDocs.

## Reproduce

The executable characterization is currently in
[test/multivault-poc.test.ts](../test/multivault-poc.test.ts), under
`characterizes bulk failure persistence` (three parameterized cases).

```sh
npm ci
npx vitest run test/multivault-poc.test.ts -t 'characterizes bulk failure persistence'
```

Run from this repository with its root lockfile and supported Node version. Tests
use local workerd SQLite; localhost listeners must be permitted. No deployment
or production credentials are required. The `unscoped` case is the important
control: no SQL namespace translation is used for the failing database. A SQL
wrapper still supplies the deliberate fault and binds native storage methods.

These tests assert the current undesirable observation. A green result means
it is reproduced, not fixed. Preserve the original reproducer when porting it
to the adapter repository so a proposed fix can be compared with this baseline.

## Meaning and limits

A caller sees an operation-level error but cannot infer that nothing was stored.
A retry could find existing documents or encounter revision conflicts. How actual
LiveSync replication and semantic writes recover needs explicit testing; no
particular client failure has been demonstrated here.

CouchDB bulk requests are not generally all-or-nothing: per-document successes
and failures can coexist. This investigation must distinguish that supported
behavior from unexpected backend exceptions and their reported outcome. Do not
"fix" it by assuming every mixed-success bulk request needs to roll back.

The injected exception happens AFTER a successful SQL statement. This is an
application/adapter fault model, not proof of behavior for every native SQLite
error, resource-limit error, network failure or process crash. The test proves
subsequent database reads see both documents. It does not independently verify
crash durability of this failed operation, attachments, every revision invariant,
change-notification delivery or the exact transaction commit boundary.

No document corruption, data loss or cross-vault leakage was demonstrated. The
underlying cause is not yet established; error handling, transaction boundaries
and callback completion are hypotheses to investigate, not confirmed diagnoses.

## Investigation plan for the separate branch

Work primarily in `robince/pouchdb-adapter-sqlite`, against the pinned source or
an equivalent baseline before assessing newer versions. Keep namespaces out of
the initial reproducer. Use these installed files as navigation references to
their source equivalents:

- `pouchdb-adapter-sqlite-core/lib/bulkDocs.js`: writeDoc/dataWritten,
  websqlProcessDocs, processDocs callback bridging and the transaction callback.
- `pouchdb-adapter-sqlite-core/lib/transactionQueue.js`: queue completion and
  propagation of callback rejection.
- `pouchdb-adapter-sqlite-core/lib/utils.js`: handleSQLiteError conversion.
- `@robince/pouchdb-adapter-cloudflare-do/lib/cloudflare-do-adapter.js`:
  query/run and storage.transaction delegation.
- `pouchdb-adapter-utils`: processDocs/writeDoc callback contract used by this
  adapter version.

1. Port the unnamespaced control to an isolated workerd adapter regression test.
   Assert the injected error actually fires, capture the returned rejection, and
   inspect physical rows as well as PouchDB reads. Record execution/commit order
   without logging real document content or credentials.
2. Trace whether the injected error reaches the storage transaction callback,
   whether document processing continues, and when the public Promise settles
   relative to transaction commit and change notification. Avoid diagnosing from
   the final rejection alone.
3. Expand fault positions: before/after sequence insert, metadata insert/update,
   attachment storage/mapping and later documents. Include a genuine failing SQL
   statement where practical, not just a wrapper exception. Test one document,
   multiple documents and an existing revision update.
4. Separate normal per-document conflict/validation results from fatal backend
   exceptions. Document the intended adapter contract. Where a backend failure
   must abort its transaction, ensure pending operations cannot continue writing
   after rollback; where partial completion is permitted, accurately represent
   the successful and failed outcomes.
5. Verify retry/reopen behavior, revisions, sequences, attachments, feeds and
   checkpoint recovery. Repeat the failure cases with concurrent operations on
   a neighbour after the single-database behavior is understood. Test eviction
   after rejection before claiming persisted crash-recovery guarantees.
6. Add the smallest source fix supported by the diagnosis, run adapter and
   PouchDB compatibility suites, and document its failure semantics. Adopt a
   released adapter update in this application as a separate dependency change
   with the root lockfile and application regression tests.

## Acceptance criteria

- The original failure is explained by a verified execution path, not merely
  hidden by changing the test or wrapping every operation in another queue.
- Fatal backend errors and normal per-document bulk results have explicit,
  tested semantics; no blanket atomicity requirement is imposed on bulkDocs.
- Public results agree with the chosen commit/rollback semantics, and no queued
  work continues outside its intended transaction after failure.
- Follow-up reads, retries and change feeds behave consistently; revision,
  sequence and attachment invariants survive the tested error paths.
- A neighbouring database's data and notifications remain independent.
- Existing successful writes, replication and mixed per-document result behavior
  retain compatibility. The package/application update includes a clear release
  note and regression evidence.

The multi-vault branch can continue implementing owner-scoped identities and
SQL schemas independently. Review this investigation before production rollout;
whether a fix is required should follow the established contract and diagnosis,
not an assumption that the namespace feature caused the observation.
