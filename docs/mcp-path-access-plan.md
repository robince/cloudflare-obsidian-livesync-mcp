# MCP path access implementation plan

Status: implemented in the working tree on 2026-10-11; not deployed.
The sections below record the reviewed design. Verification results are recorded
at the end.

## Objective and boundary

Add deployment-configured folder restrictions to MCP access, supporting hidden
folders and readable but immutable folders. Changes to both Workers and the
shared RPC contract are acceptable, with a coordinated deployment.

**Standard Obsidian LiveSync functionality must remain unchanged.** Restrictions
apply only to semantic vault RPC operations used by MCP. They must not change
CouchDB HTTP authentication, document access, replication, changes feeds, chunk
storage, revision handling, backup contents, or restore behavior. Obsidian must
continue to read, write, and synchronize every folder normally.

The MCP Worker remains trusted infrastructure: it owns the policy and passes it
over its private Durable Object binding. This protects against MCP clients and
model tool calls; it does not isolate data from the Worker operator or a
compromised Worker with raw storage access.

## Agreed access model

Configure `MCP_PATH_RULES` in the MCP Worker's environment:

```jsonc
"vars": {
  "MCP_PATH_RULES": [
    { "path": "Private/", "access": "none" },
    { "path": "Journal/", "access": "read" }
  ],
  "MCP_HIDE_DOT_FOLDERS": "false"
}
```

Accept both a JSON array binding and a JSON-encoded string for `MCP_PATH_RULES`.
Do not introduce a separate comma-separated format. Parse bindings as `unknown`
at the configuration boundary: generated Wrangler types may infer literal array
values that differ between development and production configurations.

| Effective rule | List and search | Read, outline, frontmatter, attachments | Create, edit, append, patch, delete |
| --- | --- | --- | --- |
| `none` | Omitted | `not_found` | `access_denied` |
| `read` | Included | Allowed | `access_denied` |
| No matching rule | Included | Allowed | Allowed by existing write authorization |

- Rules describe literal folder subtrees, not glob patterns or regular expressions.
- New folders are visible and potentially writable until a rule restricts them;
  there is no allowlist.
- A model with write access can discover that a path is restricted by attempting
  a write. Denials conceal whether a particular file exists, not the existence
  of restrictions.
- The most restrictive matching rule wins, independently of configuration order.
  A child `read` rule cannot reopen a parent `none` subtree.
- Rules only restrict access. Existing GitHub authorization, `vault:read`,
  `vault:write`, and `MCP_WRITES_ENABLED` continue to apply.
- Restricting a folder also prevents creating a previously nonexistent file in it.
- A copy-then-delete move checks its constituent operations: readable source,
  writable destination, and writable source for deletion. Copying out of a
  read-only folder is allowed; deleting the source is not.
- Policy changes apply to existing tokens on their next request. There is no
  policy snapshot embedded in OAuth grants.

### Configuration defaults and validation

Require an explicit `MCP_PATH_RULES` value for MCP operation. `[]` deliberately
adds no folder restrictions (MCP path validation still applies); missing or malformed configuration fails
closed with a generic client-facing configuration error. Log an operator-facing
configuration diagnostic naming `MCP_PATH_RULES` (or `MCP_HIDE_DOT_FOLDERS` for
that setting), without logging its value or folder names. Emit this when
configuration is initialized or validated, with repeated diagnostics bounded.

This deliberately requires existing deployments to add rules or `[]` before
upgrading; make the migration prominent in deployment documentation. Missing
configuration must not silently allow access after a typo or omitted binding.

Reject unknown access values, unknown fields, invalid paths, and excessive rule
counts or sizes. Define bounded limits in the shared contract and cover the
boundaries in tests. Do not echo the rules or private folder names in errors
returned to MCP clients.

Proposed dot-folder behavior: support `MCP_HIDE_DOT_FOLDERS`, defaulting to false
when omitted. Accept only `"true"` or `"false"` when supplied. When true, treat
any ancestor folder segment starting with `.` as `none`, including nested
`.obsidian/` folders. This does not automatically hide a root dot-file such as
`.example.md`. Explicit `read` rules cannot override this restriction.

Document enabling this option as the recommended setup for new deployments,
without silently changing access in existing ones.

## Path interpretation

Introduce a shared policy comparison helper used by direct operations, listing,
and search-index key generation.

1. Validate path segments before cleanup. Reject `..` segments, backslashes,
   NUL characters, and other paths already rejected by semantic vault APIs.
2. In rule configuration, accept and strip leading `/` and `./`, and treat
   `Private` and `Private/` as the same folder rule. Reject an empty/root rule
   after cleanup. Keep tool requests strictly vault-relative as they are today;
   `/Private/a.md` and `./Private/a.md` remain invalid inputs.
3. Canonically decompose comparison keys, apply Unicode 17.0 full default case
   folding, and normalize the result to NFC. Policy comparisons are always case-insensitive,
   regardless of the vault profile. Thus `Private/` also restricts `private/` in
   a case-sensitive vault. This prevents case-variant writes from evading rules
   before syncing to clients with case-insensitive filesystems. Keep ordinary
   file resolution and list/search prefix matching on their existing semantics.
4. Match complete folder boundaries: `Private/` matches descendants, not
   `Private notes/`. A folder rule does not target an unrelated root file called
   `Private`.
5. Strip trailing ASCII spaces and dots from each segment when building policy
   comparison keys, for both rules and candidate paths. Thus `Private./x.md`
   and `Private /x.md` receive the same restrictions as `Private/x.md`. Preserve
   the original path for storage operations: unrestricted folders such as `v1.`
   or `Draft ` remain writable. Reject a path or rule if a segment becomes empty
   after comparison normalization; never silently remove that segment. Do not
   claim this implements every platform's filesystem equivalence rules.

Keep comparison keys separate from stored paths and document identity. The
installed Commonlib uses paths to derive document IDs; rewriting these paths
to NFC could change which document is addressed. Preserve existing file lookup,
creation, returned spelling, and LiveSync IDs. Canonically equivalent spellings
must receive the same restrictions even if LiveSync stores them as distinct
documents. This feature does not introduce Unicode alias lookup or rename data.

Make the authorization decision from the requested comparison key before file
lookup. After resolving an existing file, defensively assert that its stored
path has the same comparison key. Under normal resolution this assertion should
never fail, since case and Unicode variants already compare equally. It is an
invariant check, not a second existence-dependent policy decision.
Run it inside the existing metadata fetch, including conflict leaf/ancestor
reads, before returning that document to the caller; do not add a separate lookup.

If the assertion fails, stop before content disclosure or mutation, log a generic
operator diagnostic without paths, and return the same fixed denial used for
that operation (`not_found` for reads, `access_denied` for writes). Do not inspect
conflicts or reconcile. This is a fail-closed response to inconsistent metadata;
it does not establish existence-indistinguishability for corrupted records.

## Implementation sequence

### 1. Shared contracts and policy primitives

Primary location: `packages/livesync-contracts/src/`.

- Define schemas and types for path rules, policy context, configuration limits,
  and the new `access_denied` error.
- Keep public MCP argument schemas unchanged. Introduce a separate internal RPC
  envelope containing the original request plus required policy context.
- Use one policy evaluator and comparison-key implementation, with helpers for
  read permission, write permission, canonical rule ordering, and fingerprints.
- Increment `CONTRACT_VERSION` from 5 for the semantic wire-contract change.
- Reject missing or malformed policy context at runtime. An explicitly empty
  rule list is allowed; omission is not an unrestricted fallback.

### 2. MCP configuration and RPC wrapper

Primary locations:

- `apps/cloudflare-obsidian-mcp/src/index.ts`
- `apps/cloudflare-obsidian-mcp/src/vault-rpc.ts`
- `apps/cloudflare-obsidian-mcp/src/vault-tools.ts`

Parse environment configuration before creating a functional MCP server. Replace
the current direct Durable Object cast with an explicit wrapper implementing
the existing tool-facing `VaultRpc` interface. Every data operation constructs
the required internal envelope from trusted configuration.

The wrapper must not forward arbitrary tool arguments as policy. Do not expose
policy fields in tool schemas or let a request override configured rules. Batch
reads must use the same wrapped single-file operation for every item.

Send the required envelope directly. Both Workers are deployed together, so do
not implement automatic version probes, fallback probes on `invalid_input`, or
mixed-version compatibility handling. `vaultStatus` remains available as an
explicit content-free diagnostic. Strict envelope validation remains required;
never retry with an unrestricted or legacy request shape.

Keep the wrapper exhaustive and add coverage tying it to the registered tool
surface. New operations must explicitly declare their access requirements;
adding a method must not silently bypass policy.

### 3. Durable Object and direct-operation enforcement

Primary locations:

- `src/pouch-database.ts`
- `src/livesync-vault/vault.ts`
- `src/livesync-vault/commonlib.ts`, shared checked metadata fetch

Validate policy envelopes at semantic RPC entry points and pass policy as
request-local context into vault operations. Do not store it as a vault-wide
setting or mutable Durable Object field: different MCP deployments can have
different policies for the same vault.

Apply read checks to file reads, outlines, frontmatter reads, and attachment
reads. Apply write checks to create, update, append, text patch, frontmatter
patch, and delete. Check before content access, conflict inspection that could
reveal revisions, and especially `reconcileBeforeMutation` or other writes.

For direct reads of syntactically valid hidden paths, return the same generic
`not_found` result whether the file exists or not. For all mutations denied by
either `none` or `read`, return one fixed response: `access_denied` / "This path
is not writable via MCP". Decide policy authorization from the requested path
before existence checks, revision checks, or reconciliation, including for
creation attempts. The defensive resolved-key assertion described above is a
separate storage invariant. This communicates a stable
write restriction without confirming file existence or distinguishing hidden
from read-only rules. Existing authentication and malformed-input errors retain
their normal precedence.

Do not apply these helpers to raw CouchDB/document methods, Commonlib's internal
replication transport, or backup/restore entry points.

### 4. Listing, search, and pagination

Primary locations: `src/livesync-vault/vault.ts` and `src/livesync-vault/search.ts`.

**Listing:** the current implementation enumerates Commonlib metadata; it is not
a SQL listing query. Skip hidden candidates before conflict metadata checks,
page accounting, and selection of continuation positions. Apply the same logic
to Markdown and attachment lists. A listing explicitly scoped to a hidden
subtree, such as `prefix: "Private/"`, returns an empty successful list with no
cursor, just like an empty or nonexistent folder; it does not return an access
error. Preserve bounded work and existing best-effort
pagination behavior; if a work limit ends a page early, preserve continuation
without exposing a hidden filename or document ID in the cursor.

**Search:** add one NFC-normalized, lowercased policy path column to the derived
search index, independent of vault case sensitivity, plus a dot-folder indicator
if useful. Preserve existing original/folded query path columns and
FTS text. Apply parameterized visibility predicates before `LIMIT/OFFSET`, using
literal boundary comparisons rather than SQL wildcard interpretation. Read-only
notes remain ordinary search results.

Apply the same visibility scope to `unindexedFiles`, `unqueryableFiles`, and
`incomplete`. A note hidden by policy is not an indexing failure and must not
cause an incomplete-coverage warning. Audit all returned snippets, selected
properties, revisions, and error details for the same restriction.

The current catch-up error includes `catchUp.pendingPath`. Suppress that path
when hidden, returning a generic temporary-unavailability message. Shared index
catch-up can still delay a query; do not skip indexing hidden content globally,
because another MCP deployment may be permitted to see it.

Bump the derived search schema version and use the existing rebuild mechanism
for new comparison columns. Rebuild only derived search tables, never PouchDB
documents. Policy changes alone must not require reindexing.

Add canonically ordered, normalized rules and the dot-folder setting to the existing
search query fingerprint. A policy mismatch uses the existing `invalid_input`
"changed query; restart search" response; no separate policy-version protocol is
needed. Preserve the existing `caseSensitive` query field because ordinary
`pathPrefix` semantics still depend on it; policy matching itself does not.

List cursors need no policy fingerprint: retain document-ID continuation and
prefix binding, and add list-kind binding so file and attachment cursors cannot
be interchanged. They remain best-effort across policy changes. Newly visible
files whose IDs precede the cursor will not appear on later pages; restart a
listing after a policy change when a complete inventory is required.

Apply current policy on every page, even for stale or forged cursors. Fingerprint
binding protects search offset consistency, not authorization. Equivalent rule
ordering should not change the search fingerprint.

### 5. Configuration, descriptions, and documentation

Update MCP Wrangler examples for production and dev, local environment examples,
OAuth test configuration, and staging configuration generation where applicable.
Regenerate Worker binding declarations after adding configuration and RPC types.
Do not modify or commit credentials or ignored deployment configuration files.

Update the MCP README, `docs/mcp-catalog.md`, and `DEPLOY.md` with:

- Configuration examples, precedence, always-case-insensitive policy matching,
  trailing-dot/space comparison normalization, and explicit `[]` migration with
  operator logs.
- Interaction with OAuth scopes and the global write switch.
- Hidden-read `not_found` and fixed write-denial `access_denied` behavior,
  including copy/delete moves and the limits of hiding restrictions themselves.
- Attachment coverage, dot-folder defaults, search policy-fingerprint mismatch,
  and restarting list pagination after policy changes for exhaustive inventory.
- Coordinated deployment and temporary search-index rebuilding behavior.
- A clear statement that normal Obsidian sync and backups retain full vault access.

Server instructions and consent text can state that folder restrictions apply,
but must not enumerate hidden rules. For the first version, do not enumerate
read-only rules either; clear write errors are sufficient and avoid exposing
rules nested beneath hidden parents.

Document the content boundary: visible notes can contain copied private text,
filenames, links, or literal embed references such as `![[Private/Diary]]`.
These references are not redacted; fetching a hidden target still fails. Shared
attachments must be restricted by their own paths. Previously retrieved content
cannot be retracted. The shared index can still have timing, ranking, or cursor
invalidation effects from hidden data; this is access control, not full storage
or side-channel isolation.

### 6. Regression coverage and acceptance checks

Add focused policy tests and extend the existing suites:

| Area | Required coverage |
| --- | --- |
| Policy parser and matcher | Array/string bindings parsed as unknown; missing/invalid configuration and safe operator diagnostics; explicit `[]`; size limits; overlap and order independence; folder boundaries; root cleanup; traversal rejection; case-variant restrictions under both vault profiles; NFC/NFD variants; trailing-dot/space equivalence for rules and paths; rejection of segments normalizing to empty; dot-folders |
| Direct operations | Every read and mutation; identical hidden-read errors for existing and nonexistent files; identical write-denial code/message across hidden/read-only and existing/nonexistent targets; mixed batch outcomes; attachments; case-variant and trailing-dot/space create/overwrite attempts; unrestricted dotted/spaced folders remain writable; resolved-key invariant and fixed failure responses; no reconciliation or revision-tree changes on denial |
| Discovery | Root and nested listing/search; successful empty lists for hidden prefixes; all-hidden results; hidden entries before/between/after visible entries; no omissions or duplicates across complete pagination with a stable policy; file/attachment cursor separation; no hidden paths in decoded cursors; visible-page accounting; search byte budgets; policy-filtered counts and errors |
| Search policy binding | A search cursor issued under one policy is rejected under another using the existing changed-query error |
| MCP boundary | Real MCP client through wrapper and Durable Object serialization; policy injection attempts rejected; missing internal context rejected; strict envelope validation; no automatic compatibility probes or legacy retries; stale/forged cursors never expand access; OAuth/global restrictions remain effective |
| Isolation between clients | Two differently configured wrappers querying the same Durable Object in interleaved requests receive only their permitted data |
| Standard sync | Seed and update hidden/read-only files through normal CouchDB replication; verify they still synchronize while MCP denies the corresponding operations; preserve revisions, conflicts, chunks, and attachment content |
| Derived index migration | Existing index rebuilds successfully; original document IDs and paths remain unchanged; policy changes reuse the index |

Use `test/vault-rpc.test.ts`, `test/vault-conflicts.test.ts`,
`test/mcp-storage-integration.test.ts`, the MCP tool/OAuth tests, and existing
replication fixtures as appropriate. If adding separate test files, include them
in the root test script, which currently lists several suites explicitly.

Run the repository's required checks after implementation:

```sh
npm run types:check
npm run check
npm run test:all
npm run dry-run
```

## Deployment and completion criteria

Deploy storage first and MCP second using the existing coordinated deployment
order. A brief MCP incompatibility window is acceptable; normal CouchDB sync
must remain available throughout. Do not support unrestricted legacy semantic
data calls as a compatibility workaround. Rollbacks must preserve enforcement or
disable MCP until both versions are compatible.

Before deploying, update each MCP environment with explicit rules or `[]`.
After deployment, verify a visible note, hidden note, read-only note, and
attachment through MCP, then confirm normal LiveSync still synchronizes the
restricted folders. Use a disposable staging vault for mutation checks.

The feature is complete when all MCP data operations enforce the configured
policy, pagination and returned metadata respect visibility, denied mutations
leave documents untouched, and the standard sync/backup regression suites pass.

## Out of scope

- Per-user or per-client OAuth folder grants within one MCP deployment.
- Allowlist mode, child exceptions that reopen blocked parents, and glob rules.
- A vault-hosted `.mcpignore` file or management UI.
- Content redaction, link rewriting, automatic attachment inheritance, or atomic moves.
- Unicode alias resolution, document renaming, or changes to LiveSync storage identity.
- Separate indexes or physical storage isolation for each policy.


## Implementation verification

Implemented policy-bearing semantic RPC envelopes (contract 6), shared normalized
folder rules, server-side read/write enforcement, policy-filtered listing/search,
search schema 5, deployment configuration and operational documentation. Normal
CouchDB protocol entry points and backup/restore behavior were left unchanged.

Added configuration/matcher unit tests and workerd integration tests covering all
read/write forms, case-sensitive and insensitive vaults, Unicode and trailing
space/dot aliases, pagination, search diagnostics, attachment restrictions,
conflict preservation, mixed MCP batches, policy injection rejection, derived
index migration, inconsistent-path assertions, and ordinary CouchDB replication
of restricted notes and attachments. Existing suites explicitly supply empty
policies through the new RPC envelope.

Validation: `npm run types:check`, `npm run check`, `npm run test:all`, and
`npm run dry-run`. No deployment or live-vault mutation was performed.

Implementation detail: committed Wrangler defaults use `MCP_PATH_RULES: "[]"`
because this Wrangler version emits an invalid `()[]` type for an empty JSON
array with `--strict-vars=false`. Native JSON arrays remain accepted at runtime.
