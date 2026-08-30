# Read-only Obsidian LiveSync MCP Worker

This Worker exposes authenticated tools for one configured vault:
`vault_status`, `list_files`, `read_file`, `create_file`, `edit_file`,
`delete_file`, and `move_file`. It never accepts a database name from an MCP
client. Writes require the current document revision.

## Configure

Set these non-secret Worker variables before deployment:

- `VAULT_DATABASE` — the existing LiveSync database name.
- `MCP_PUBLIC_BASE_URL` — the exact public HTTPS origin, such as
  `https://vault-mcp.example.com`; no path is allowed.
- `GITHUB_ALLOWED_LOGINS` — a comma- or whitespace-separated GitHub login
  allowlist. An empty value allows nobody.

Set these Worker secrets through Wrangler or the Cloudflare dashboard:

- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`

Register GitHub's callback URL as
`https://your-mcp-origin.example/oauth/github/callback`. The OAuth provider
serves the MCP authorization metadata, PKCE token flow, Client ID Metadata
Document support, and dynamic registration. The app handles a GitHub login and
explicit consent page, then stores only the immutable GitHub user ID, normalized
login, and granted `vault:read` scope in MCP token properties. It does not store
the GitHub access token.

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
workspace tests. Vault status/list/read go through the storage Durable Object in
the root workerd suite. Interactive OAuth against a disposable vault is the
staging checkpoint.
