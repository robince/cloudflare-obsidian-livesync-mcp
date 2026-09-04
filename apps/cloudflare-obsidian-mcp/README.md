# Obsidian LiveSync MCP Worker

This Worker exposes authenticated tools for one configured vault:

- read tools: `vault_status`, `list_files`, `read_file`, `read_frontmatter`,
  `list_attachments`, and `read_attachment`;
- write tools: `create_file`, `edit_file`, `append_file`, `patch_file`,
  `patch_frontmatter`, and `delete_file`.

It never accepts a database name from an MCP client. Editing, appending,
patching, frontmatter updates, and deletion require the current document
revision; creation is create-only. File listings include LiveSync's size,
creation-time, and modification-time metadata when present. Attachment reads
are base64 encoded and limited to 512,000 decoded bytes.

## Configure

Set these non-secret Worker variables before deployment:

- `VAULT_DATABASE` — the existing LiveSync database name.
- `MCP_PUBLIC_BASE_URL` — the exact public HTTPS origin, such as
  `https://vault-mcp.example.com`; no path is allowed.
- `GITHUB_ALLOWED_LOGINS` — a comma- or whitespace-separated GitHub login
  allowlist. An empty value allows nobody.
- `MCP_WRITES_ENABLED` — exact string `true` enables write tools. Every other
  value disables them; the committed default is `false`.

Set these Worker secrets through Wrangler or the Cloudflare dashboard:

- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`

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

Create and configure the `OAUTH_KV` namespace in the deployed Wrangler config;
the committed preview ID is only a local placeholder. The Worker also needs the
cross-script `POUCH_DATABASES` Durable Object binding targeting the unchanged
`cloudflare-pouchdb` Worker.

## Verify

```sh
npm run check --workspace @cloudflare-obsidian-livesync/mcp
npm test --workspace @cloudflare-obsidian-livesync/mcp
npm run dry-run --workspace @cloudflare-obsidian-livesync/mcp
```

Tool registration, output schemas, and allowlist checks are covered by the MCP
workspace tests. The workerd suite runs the MCP Worker and a Wrangler-built
storage Worker together: after a real DCR, PKCE, consent, callback, and token
exchange flow, authenticated read-tool calls
requests cross the configured external Durable Object binding. It also covers
callback replay protection, CSRF rejection, and allowlist denial. Interactive
OAuth with GitHub and a disposable vault remains a staging checkpoint.
