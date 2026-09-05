# Obsidian LiveSync MCP Worker

This Worker exposes authenticated tools for one configured vault:

- read tools: `vault_status`, `list_files`, `search_files`, `read_file`, `read_frontmatter`,
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

The semantic contract is version 4; deploy storage before the matching MCP
Worker. This does not change the CouchDB replication protocol.

## Deployment configuration

Copy `wrangler.jsonc` to the ignored `wrangler.deploy.jsonc` beside it. Keep
portable defaults in the committed file and put these non-secret settings in
the deployment copy's `vars`:

- `GITHUB_CLIENT_ID` — the public GitHub OAuth app client ID.
- `VAULT_DATABASE` — the existing LiveSync database name.
- `MCP_PUBLIC_BASE_URL` — the exact public HTTPS origin, such as
  `https://vault-mcp.example.com`; no path is allowed.
- `GITHUB_ALLOWED_LOGINS` — a comma- or whitespace-separated GitHub login
  allowlist. An empty value allows nobody.
- `MCP_WRITES_ENABLED` — exact string `true` enables write tools. Every other
  value disables them; the committed template defaults to `false`.

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
Object binding targeting the unchanged `cloudflare-pouchdb` Worker.

For a workers.dev deployment, reuse the account subdomain from the existing
storage URL: `https://cloudflare-obsidian-mcp.<account-subdomain>.workers.dev`.
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
