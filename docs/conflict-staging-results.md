# Conflict checkpoints — execution record

Date: 2026-09-04. Target: Self-hosted LiveSync 1.0.21 / Commonlib 0.1.19.

## Conflict parity and MCP feedback

Implementation committed as `873ea7d`.

- Dependency provenance and workspace typechecks: passed.
- Storage, Commonlib bridge, MCP integration, and OAuth Worker suites: passed.
- Thirteen focused conflict cases: passed, including winning-CAS and losing-leaf
  races, missing bodies/history, duplicate collapse, and bounded pairwise progress.
- Both Worker builds: passed; raw CouchDB route implementation is unchanged.
- Real HTTP MCP read error retains code/path/version-count/recovery instructions
  and does not resolve a conflict: passed.

## Disposable staging

- Separate, uniquely named remote storage/MCP Workers and OAuth KV: provisioned.
- Remote MCP metadata advertises only `vault:read`: verified (HTTP 200).
- Pinned clean source worktree, dependency installation, plug-in build, and
  staging preflight: passed.
- Two real isolated desktop clients load pinned LiveSync: passed.
- Real client A → remote staging storage → client B → remote staging storage →
  client A round-trip, using a separate disposable database: passed.
- Test processes stopped and their temporary vaults/profiles removed: passed.
- Real GitHub OAuth read consent and private token capture: passed.
- Separate real write consent and private token capture: passed.
- Real-client normal MCP create/edit/append/delete propagation and stale CAS
  refusal: passed in the first partial matrix run.
- Real-client non-overlapping conflict reconciliation, explicit MCP feedback,
  deliberate retry, and two-vault convergence: passed in that run.
- Authenticated initial read-only preflight: passed. Write tools are absent and
  denied; `vault_status` reports `not_found`, independently confirmed as the
  intentionally not-yet-created disposable database. Successful file reads
  remain a requirement of the full matrix.

The subsequent full matrix passed all eight cases: normal/stale CAS, safe merge,
identical content, overlap, delete/edit, independent creates, three branches,
and differing binary attachments. The four real Obsidian conflict-dialogue
screenshots were visually reviewed. Failed earlier runs remain private evidence,
not acceptance passes.

- Post-write kill switch with the previously issued write grant: passed;
  writes absent/denied, actual file reads succeed, revision tree unchanged.
- RFC 7009 revocation of the write token: passed, old token returns HTTP 401.
- Staging MCP rollback followed by real A → B → A replication: passed.
- Staging storage rollback followed by real A → B → A replication: passed.
- MCP restored to the verified write-disabled version: completed.
- Fresh restricted consent after revocation: passed. With staging writes enabled,
  the new read grant reads successfully, receives explicit write-scope denial,
  and creates no file or revision change. The revoked write token still returns
  HTTP 401. Final write-disabled verification also passes.

The storage rollback exercised a previously deployed compatible build of the
same storage implementation; it is not evidence for arbitrary schema downgrades.

Checkpoint 2 is **accepted**. Local `npm run check`, `npm run test:all`, staging
script syntax checks, and diff whitespace checks pass.
Deployment identifiers, raw screenshots,
temporary paths, private backup contents, and credentials are deliberately absent
from this record; private cleanup references remain in ignored local artefacts.
