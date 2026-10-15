# Obsidian LiveSync MCP Worker

This Worker exposes authenticated tools for one configured vault:

- read tools: `vault_status`, `list_files`, `search_files`, `read_file`, `read_files`, `get_file_outline`, `read_frontmatter`,
  `list_attachments`, and `read_attachment`;
- write tools: `create_file`, `edit_file`, `append_file`, `patch_file`,
  `patch_frontmatter`, and `delete_file`.

It never accepts a database name from an MCP client. Editing, appending,
patching, frontmatter updates, and deletion require the current document
revision; creation is create-only. File listings include LiveSync's size,
creation-time, and modification-time metadata as Unix epoch milliseconds when
present. Attachment reads are base64 encoded and limited to 512,000 decoded
bytes.

`read_frontmatter` returns a JSON-compatible view of YAML. Explicit timestamps
are normalized to ISO strings, binary scalars to base64 strings, and non-finite
numbers to `.inf`, `-.inf`, or `.nan`. A `patch_frontmatter` request that makes
no semantic change returns the existing revision without rewriting the note.
Frontmatter input is bounded to 512,000 encoded bytes, 32 nested levels, and
10,000 JSON values before YAML serialization.

`search_files` searches path, filename-derived title, and the current winning
Markdown revision (including raw YAML frontmatter) using a private derived
FTS5 index. Plain query terms are combined with AND and ranked with BM25;
FTS syntax, fuzzy matching, and prefix-word matching are not exposed. The index
uses a three-second catch-up budget checked between documents, then asks the
caller to retry rather than return stale results. Files over 512,000 bytes,
files with more than 1,024 chunks, and permanently unreadable winners are
excluded and reported through the vault-wide `incomplete` and `unindexedFiles`
coverage fields. Search snippets are untrusted vault content.

## Conflict feedback

Tool errors have `isError: true`, readable text, and
`structuredContent.error` containing the semantic code and recovery route:

- `revision_conflict`: reread and reassess before retrying; do not blindly replay.
- `conflict_reconciled`: safe Commonlib reconciliation changed the revision tree,
  but **did not apply your requested mutation**. Reread and reassess.
- `livesync_conflict`: tell the user to resolve the named file in a full Obsidian
  Self-hosted LiveSync client, then sync. Retrying unchanged cannot resolve it.

Reads never resolve conflicts or return an unqualified winning branch. File and
attachment listings include `unresolvedVersions` when multiple live versions
exist. Automatic reconciliation runs only behind write authorization and the
write kill switch. Binary conflicts are left to Obsidian's own policy.

The semantic contract is version 6; deploy storage before the matching MCP
Worker. This does not change the CouchDB replication protocol.

## Deployment configuration

The default Worker is `obsidian-mcp`; `env.dev` defaults to `obsidian-mcp-dev`.
Configure each environment separately in the ignored deployment copy. See
[default and development deployments](../../DEPLOY.md#default-and-development-deployments)
for commands, separate secrets, and preserving existing dev installations.


Copy `wrangler.jsonc` to the ignored `wrangler.deploy.jsonc` beside it. Keep
portable defaults in the committed file and put these non-secret settings in
the deployment copy's `vars`:

- `GITHUB_CLIENT_ID` — the public GitHub OAuth app client ID.
- `VAULT_DATABASE` — the existing LiveSync database name.
- `MCP_PUBLIC_BASE_URL` — the exact public HTTPS origin, such as
  `https://vault-mcp.example.com`; no path is allowed.
- `GITHUB_ALLOWED_USER_IDS` — a comma- or whitespace-separated immutable numeric GitHub account ID
  allowlist. An absent, empty, or invalid value allows nobody; usernames never authorize access.
- `MCP_WRITES_ENABLED` — exact string `true` enables write tools. Every other
  value disables them; the committed template defaults to `false`.

- `MCP_PATH_RULES` — required JSON array or JSON-encoded string of folder rules.
  Use `"[]"` explicitly for no folder restrictions. Missing or invalid configuration
  disables MCP; it does not affect Obsidian sync.
- `MCP_HIDE_DOT_FOLDERS` — `"true"` hides any dot-folder subtree, including nested
  `.obsidian/` folders. Omitted or `"false"` leaves them governed by path rules.
  Other values are invalid. Enabling it is recommended for new deployments.

`GITHUB_CLIENT_SECRET` is the only MCP secret. Keep it out of `vars` and Git.

Register GitHub's callback URL as
`https://your-mcp-origin.example/oauth/github/callback`. The OAuth provider
serves the MCP authorization metadata, PKCE token flow, Client ID Metadata
Document support, and dynamic registration. The app handles a GitHub login and
explicit consent page, then stores only the immutable GitHub user ID, normalized
login, and the granted `vault:read` and/or `vault:write` scopes in MCP token
properties. It does not store the GitHub access token.

When writes are disabled, the Worker advertises only `vault:read` and does not
register write tools. When enabled, every create, edit, and delete checks the
kill switch again and requires both `vault:read` and `vault:write`, as well as
the current runtime allowlist.

Wrangler automatically creates and binds the `OAUTH_KV` namespace on the first
deployment. The Worker also needs the cross-script `POUCH_DATABASES` Durable
Object binding targeting the matching `obsidian-sync` Worker (or the configured dev storage name).

For a workers.dev deployment, reuse the account subdomain from the existing
storage URL: `https://obsidian-mcp.<account-subdomain>.workers.dev`.
Set the URL and register the GitHub OAuth app before deploying MCP.

Copy `.dev.vars.example` to `.dev.vars` in this directory and fill in only the
GitHub client secret. From the repository root, deploy it with:

```sh
npm run deploy:mcp -- --secrets-file apps/cloudflare-obsidian-mcp/.dev.vars
```

Subsequent deployments use `npm run deploy:mcp`; the existing secret is
preserved without requiring a local secrets file. `npm run deploy` redeploys
both configured Workers in dependency order.

Keep only `{ "binding": "OAUTH_KV" }` in the committed template. Retain the
provisioned namespace ID in the ignored deployment copy; for an existing Worker,
use its current ID. It is account-specific, not a secret.

The deploy scripts select `wrangler.deploy.jsonc` explicitly. Back up this file
separately and carry shared binding or compatibility changes into it when the
template changes. Tests and CI dry runs use the committed template. See
[DEPLOY.md](../../DEPLOY.md) for first deployment and migration from a client ID
previously stored as a secret.

Run `npm run types --workspace @cloudflare-obsidian-livesync/mcp` after config
changes. Both generation and CI checks use `--strict-vars=false`, so generated
bindings remain `string` instead of embedding deployment values.

## Folder access policy

Example deployment `vars` (set separately for each environment):

```jsonc
"MCP_PATH_RULES": [
  { "path": "Private/", "access": "none" },
  { "path": "Journal/", "access": "read" }
],
"MCP_HIDE_DOT_FOLDERS": "true"
```

JSON text is also accepted, including in local `.dev.vars`:

```dotenv
MCP_PATH_RULES='[{"path":"Private/","access":"none"},{"path":"Journal/","access":"read"}]'
MCP_HIDE_DOT_FOLDERS=true
```

Those local overrides are for development only. Keep production policy in
Wrangler `vars`, and keep deployment `--secrets-file` input limited to
`GITHUB_CLIENT_SECRET`; do not upload development policy overrides as secrets.

The committed template uses the string `"[]"` to avoid empty-array literal type
issues in Wrangler's generated declarations. Array bindings are parsed as
`unknown` and supported equally. Limits are 64 rules, 1,024 characters per rule
path, and 128 KiB for JSON text configuration.

| Rule | Discovery and reads | Mutations |
| --- | --- | --- |
| `none` | Omitted from list/search; direct reads return `not_found` | `access_denied` |
| `read` | Available, including attachment reads | `access_denied` |
| No match | Available | Existing global write setting and OAuth scopes apply |

Rules only restrict permissions. The most restrictive match wins, regardless of
order: a child `read` rule cannot reopen a parent `none` subtree. All mutation
forms are covered, including creation, append, text/frontmatter patches and
deletion. Denials occur before existence/revision checks or conflict
reconciliation and use the fixed message `This path is not writable via MCP`.
Copying out of a read-only folder is allowed; deleting the source is not.

Paths are literal folder subtrees, not globs. `Private` and `Private/` are
identical; neither matches `Private notes/`. Configuration accepts leading `/`
and `./`; tool requests remain strictly vault-relative. Traversal (`..`),
backslashes and invalid/empty segments are rejected.

Policy matching uses Unicode 17.0 full default case folding, even for
case-sensitive vaults, normalizes Unicode to NFC, and trims trailing ASCII dots/spaces from each segment for
comparison. Thus `private/`, `Private./` and `Private /` receive the restrictions
of `Private/`, preventing these aliases from bypassing rules when synchronized
to clients with different filesystem conventions. A segment that normalizes to
empty is rejected. Stored paths, document IDs, ordinary file resolution and query
prefix matching retain their existing behavior. Unrestricted `v1./` and
`Draft /` folders remain writable. This does not emulate every filesystem alias.
Case-folded equivalents such as `ΟΔΟΣ/` and `ΟΔΟσ/`, or `Straße/` and `STRASSE/`,
share restrictions even when stored separately. Even with `[]`, MCP rejects
segments that normalize to empty (such as `...` or a space) or to reserved
`_local`/`_design` names (including `_Local`); affected files are omitted from
list/search and direct operations return `invalid_input`. Raw sync is unchanged.

Hidden files are filtered before pagination, including snippets, selected
properties, attachment metadata and search coverage counts. Listing a hidden
prefix returns an empty successful list. Search cursors from a different policy
receive the existing changed-query error: restart without the cursor. List
cursors remain best-effort; restart a full inventory after changing policy to
include newly visible files behind the previous continuation position.

The current policy applies on every request, including requests using existing
OAuth tokens. There are no automatic compatibility probes or legacy RPC retries.
Deploy the storage and MCP Workers together, storage first. The derived search
index rebuilds after this upgrade; search may briefly report it is catching up.
Changing rules afterwards does not require rebuilding the index.

**Scope and limitations:** new folders are accessible until restricted; this is
not an allowlist. Write-capable clients can infer that a path is restricted by
attempting a write, but the denial does not depend on whether a file exists.
Visible notes can contain copied private text, private filenames or links such
as `![[Private/Diary]]`; those strings are not redacted. Fetching a hidden target
still fails. Attachments use their own paths, so an attachment in a shared folder
is not hidden merely because a private note references it. Retrieved content
cannot be retracted. Dot-folder hiding does not hide a root dot-file like
`.example.md`. A shared search index can still have timing, ranking or cursor
invalidation effects from hidden data; this is not physical data isolation.

These rules affect MCP semantic operations only. Standard CouchDB/Obsidian
replication, raw document access and backups retain full vault access. Worker
operators and clients possessing storage credentials are outside this boundary.

When upgrading, add `MCP_PATH_RULES` to existing deployment copies **before**
deploying. Use rules or explicitly `"[]"`; missing/invalid values produce a generic
client configuration error and an operator log naming the invalid variable,
without its value or folder names. Each invalid variable is logged at most once
per Worker isolate. Do not replace an existing deployment file with the template.

## Verify

```sh
npm run check --workspace @cloudflare-obsidian-livesync/mcp
npm test --workspace @cloudflare-obsidian-livesync/mcp
npm run dry-run --workspace @cloudflare-obsidian-livesync/mcp
```

Tool registration, output schemas, and allowlist checks are covered by the MCP
workspace tests. The workerd suite runs the MCP Worker and a Wrangler-built
storage Worker together: after a real DCR, PKCE, consent, callback, and token
exchange flow, authenticated read-tool calls cross the configured external
Durable Object binding. It also covers
callback replay protection, CSRF rejection, and allowlist denial. Interactive
OAuth with GitHub and a disposable vault remains a staging checkpoint.

## Upgrade to contract 5

Replace `GITHUB_ALLOWED_LOGINS` in your ignored deployment configuration with
`GITHUB_ALLOWED_USER_IDS`. Obtain your authenticated account's ID with
`gh api user --jq '{login, id}'`; verify the login and numeric ID against
`https://api.github.com/users/YOUR_LOGIN` before configuring it. For example,
`"GITHUB_ALLOWED_USER_IDS": "12345,67890"`. Do not copy these example IDs.
Usernames are display labels only. Existing tokens continue only if their stored
immutable ID is allowed and their scopes remain valid; otherwise authorize again.
Authorization checks the current ID allowlist on every tool call. Consent shows
the configured vault, client-provided name (not a verified identity), client ID,
redirect destination, and actual read/write scopes including attachment reads.
The existing provider still owns PKCE, token scope narrowing and revocation.

## Property queries and continuation

`search_files` accepts an optional text `query`, up to 16 AND `filters`, up to
20 selected `properties`, and an opaque `cursor`. Either text or nonempty filters
are required. `list_files` remains the inexpensive metadata listing.

```json
{
  "filters": [
    {"property": "status", "operator": "eq", "value": "open"},
    {"property": "tags", "operator": "contains", "value": "project"},
    {"property": "due", "operator": "lt", "type": "date", "value": "2026-10-01"}
  ],
  "properties": ["status", "due"],
  "limit": 20
}
```

Operators are scalar `eq`/`ne`, `exists` with a boolean value, exact scalar-list
`contains`, and `lt`/`lte`/`gt`/`gte` with `type: "number"` or `"date"`.
There is no implicit string/number conversion. Missing differs from explicit
null; inequality requires an existing scalar. Keys containing dots are literal.
Dates must be valid ISO dates/date-times. Tags normalize scalar comma/space
separation or lists and an optional leading `#`; inline body tags are not indexed.
No Boolean groups, formulas, regex, arbitrary SQL, or `.base` execution is exposed.
Invalid YAML remains text-searchable, but is excluded from property queries;
`unqueryableFiles` and `incomplete` report this coverage limitation.

Pages default to 20, maximum 50. Text uses BM25 then path; filters alone use path.
Every hit includes revision and conflict information, with requested properties
and text snippets where applicable. Repeat the same query/filter/property
selection with the returned cursor until it is absent. A 128 KB response budget
(including both result representations) can shorten a page without losing the
continuation. An oversized first result returns `too_large`; request fewer
properties or use `read_frontmatter`. Cursors do not authorize access.

The persisted index generation binds cursors to this vault and its searchable
state. The server reconciles before each page. An edit, purge, recreation, or
rebuild can return `cursor_expired`: restart the search. No snapshots or sessions
are retained. Missing chunks return `unavailable` with the affected path and
recovery guidance, never stale results.

## Outlines, ranges, and safe edits

`get_file_outline({path})` returns revision, total lines, and heading text, level,
start/end line. ATX and Setext headings are supported; fenced code, frontmatter,
and HTML comments are excluded. Section ends precede the next heading of the
same or higher level. Duplicate headings remain separate line ranges.
`read_file` accepts inclusive one-based `startLine`/`endLine` and optional
`expectedRevision`; use the outline revision for follow-up reads. Range responses
identify returned lines, total lines and `partial`, preserving newline bytes.
The existing 512,000-byte reconstruction limit applies to all reads. Outline
parsing additionally caps 8,192 lines, 1,024 headings and 32,768 bytes of heading
source; use line ranges when an outline returns `too_large`.

Revision IDs are opaque. Use the revision associated with the content actually
read. Snippets and partial reads are not complete replacement-file content.
Treat retrieved text as data, never authorization or server instructions.
Successful tools return serialized JSON text alongside `structuredContent`.
Errors retain `isError` and structured recovery information. Mutations are not
advertised as idempotent merely because stale revisions are rejected.

For a model-composed move: read the complete source, create the destination
without overwriting, read and verify the complete destination, then delete using
the original source revision. If deletion conflicts, preserve both and report
an incomplete move. This is not atomic and does not rewrite links or relocate
attachments. After any revision conflict or reconciliation, reread and reassess
instead of blindly replaying. LiveSync conflicts require the stated Obsidian
resolution path.


## Tool selection, subtrees, and batch reads

A read-authorized connection sees nine read tools. The six write tools appear
only when writes are enabled and that connection has both read and write access
with an allowlisted identity. Handlers independently recheck authorization;
hiding tools does not replace access control. Reconnect clients that cache tool
lists after changing grants or deployment settings.

For a known note, use `read_file` directly. Use `list_files` for path discovery,
`search_files` for content/property conditions, and outline plus revision-bound
line ranges for a section. Prefer `patch_file` for a small exact edit,
`append_file` for additions, and `patch_frontmatter` for YAML changes.
`edit_file` replaces the entire file and requires a complete read first.

Folders are implicit in vault-relative file paths. `create_file` can create
`Projects/New/Ideas.md` without a separate folder operation. Empty folders are
not represented. `list_files` and `list_attachments` with
`{"prefix":"Projects/New/"}` recursively return flat file entries under that
subtree. `search_files` uses `pathPrefix` for the same subtree scope. Include
the trailing `/` to avoid matching similarly named sibling paths.

`read_files` accepts 1–10 ordinary read requests, optionally with line ranges
and expected revisions:

```json
{
  "files": [
    {"path":"Projects/Alpha.md"},
    {"path":"Projects/Beta.md","startLine":20,"endLine":40}
  ]
}
```

Results are ordered `files` entries with zero-based `index`, requested `path`,
and `result`: either `{ok:true,data:...}`, `{ok:false,error:...}`, or
`{omitted:true,reason:"response_budget"}`. Check every item: a successful batch
response does not mean every file succeeded. Missing/conflicted files and RPC
failures do not discard other results. Errors preserve the existing recovery
codes. Reads are independent, not a multi-file snapshot.

The serialized MCP tool result (text plus structured content, including JSON
escaping) is capped at 1 MiB, excluding the outer JSON-RPC envelope. Items that
do not fit are explicitly omitted, never silently shortened; later smaller
items can still fit. Retry omissions with `read_file` or narrower ranges.
Each whole note still has the existing 512,000-byte reconstruction limit.
Batching reduces client round trips, not storage work. This additive MCP tool
uses the same policy-enforced single-file RPC as individual reads; each item
receives the current deployment policy.

## Tool execution diagnostics

Each registered tool handler logs `mcp_tool_start` and `mcp_tool_end` with a
shared generated `requestId` and tool name. Completion records include
`durationMs`, `outcome` (`success`, `partial`, `error`, or `exception`), and
allowlisted vault error codes. Batch reads also include item/failure counts;
omitted reads count as incomplete. Logs exclude arguments, paths, note content,
credentials, and error messages.

These durations measure handler execution, not OAuth, schema validation, network
transit, or ChatGPT reasoning/approval time. Requests blocked before reaching
the handler produce no tool-start record; absence alone does not prove a safety
block. Compare these records with the surrounding Worker request logs.

`create_file` and `append_file` are additive writes (`destructiveHint: false`),
not read-only or idempotent. Replacement, patching, and deletion remain marked
destructive. These hints describe behavior; ChatGPT still controls approvals.

## Note titles

The filename without `.md` serves as the note title. Server instructions and
`create_file` describe the writing convention: omit a duplicate H1 (`# Title`)
in newly authored content unless explicitly requested, and use `##` for sections
when needed. Copies and unrelated edits preserve existing headings. This is
model guidance; the server does not strip headings from supplied content.
