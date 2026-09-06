# Obsidian LiveSync on Cloudflare

Sync your Obsidian notes between devices, and optionally give your AI tools a
shared place to read and save notes. This project lets you deploy your own
Self-hosted LiveSync server on Cloudflare's free tier, with a separate cloud
MCP server for access from compatible AI products.

There are two components, deployed to your own Cloudflare account:

| Component | What it does | When you need it |
| --- | --- | --- |
| **Sync server** (`obsidian-sync`) | A CouchDB-compatible server for Obsidian's Self-hosted LiveSync plugin, with daily R2 backups. | Use it on its own to sync notes between desktop and mobile. |
| **MCP server** (`obsidian-mcp`) | A simple, authenticated interface for AI tools to read and update one vault. | Optional; connects to the sync server's storage. |

I expect normal personal use—one vault, even with LiveSync running all the
time—to fit within Cloudflare's generous free tier. Multiple vaults, heavy use,
or large backups could push you beyond those allowances. See the
[Durable Objects allowances](https://developers.cloudflare.com/durable-objects/platform/pricing/)
and [R2 free tier](https://developers.cloudflare.com/r2/pricing/).

**This is experimental. Start with a disposable vault, and read the
[caveats](#caveats) before trusting it with notes.**

## How to use

You need a **Cloudflare account**, Git, and
Node.js **22.18.x–22.x or 24.11.0 and later**. Install
[Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) in Obsidian on
each device. A **GitHub account and OAuth app** are needed if you add MCP
access; a GitHub account is also needed for the Deploy to Cloudflare button.

### 1. Deploy the sync server

Clone the repository and create your local configuration:

```sh
git clone https://github.com/robince/cloudflare-obsidian-livesync-mcp.git
cd cloudflare-obsidian-livesync-mcp
npm ci
cp wrangler.jsonc wrangler.deploy.jsonc
cp .dev.vars.example .dev.vars
```

Generate a strong password with:

```sh
openssl rand -hex 32
```

Copy the result into `.dev.vars` as `COUCHDB_PASSWORD`. In
`wrangler.deploy.jsonc`, set `BACKUP_DATABASE` to your intended LiveSync database name (default `vault`).
Keep both files private and backed up.

**Choose whether to use backups before deploying:**

- **With backups (default):** In the Cloudflare dashboard, open **Storage &
  databases → R2 → Overview** and complete the R2 checkout to activate it.
  R2 includes **10 GB of free storage per month** (measured as GB-month), plus
  free monthly operation allowances. Usage above those allowances is billed.
  Deployment creates the backup bucket for you. See
  [R2 setup](https://developers.cloudflare.com/r2/get-started/) and
  [free-tier details](https://developers.cloudflare.com/r2/pricing/).
- **Without backups or R2 checkout:** Set `vars.BACKUP_ENABLED` to the string
  `"false"` in `wrangler.deploy.jsonc`. The deployment script automatically
  leaves out the R2 binding and backup schedule. Sync and MCP still work;
  keep your own backups. Set it back to `"true"` and redeploy to enable backups.

Then deploy:

```sh
npx wrangler login
npm run deploy:storage -- --secrets-file .dev.vars
```

Wrangler creates the configured resources and prints your sync server URL.
For the full procedure,
updates, and the Deploy to Cloudflare button, see [Deployment](DEPLOY.md).

### 2. Connect Obsidian

In Self-hosted LiveSync, configure CouchDB with:

| Setting | Value |
| --- | --- |
| URI | Your sync Worker URL, without a database suffix |
| Database | `vault`, or the name you chose above |
| Username | `admin`, unless you changed `COUCHDB_USERNAME` |
| Password | Your `COUCHDB_PASSWORD` |

Keep the custom chunk size at its default (`0`). Sync a test note between
devices before adding MCP.

### Recommended sync mode

Start with **LiveSync** mode on every device. I've had better luck with it.
Once syncing is working, you can try **Periodic and Events** with a
**60-second interval** to let the server become idle between syncs. In that
mode, AI edits arrive on the next sync. See
[LiveSync settings](docs/livesync-settings.md) for the options.

## Optional: give AI tools access with MCP

The separate MCP Worker gives compatible AI products an always-available cloud
endpoint for your vault, even when Obsidian is closed. Your AI product must
support remote MCP with OAuth. Once the server is configured, connecting a
client needs just its MCP URL and a GitHub sign-in.

**Your vault must have LiveSync encryption disabled for MCP access.** The data
is hosted in your own Cloudflare account, and authorized AI clients can read
the notes you give them access to.

The interface is deliberately small and focused on notes:

- Find files, search note text or frontmatter properties, and read notes,
  sections, outlines, or small attachments.
- Create notes, append text, make targeted edits, update frontmatter, or delete
  notes when writes are enabled.
- Work with one configured vault. Existing-note changes require the revision
  that was read, so stale edits are rejected; unresolved sync conflicts are
  reported for resolution in Obsidian.

Writes are **disabled by default**. GitHub sign-in is restricted to an allowlist
of numeric account IDs. The interface exposes neither arbitrary database
queries nor code execution. See the [MCP reference](apps/cloudflare-obsidian-mcp/README.md)
for tools and limits.

### Vault-specific AI instructions

Add an optional `_AI_INSTRUCTIONS.md` note at the root of your vault to describe
your folder layout, naming conventions, and templates. For example, specify
where conversation summaries and daily notes belong, which timezone to use,
and where to put attachments. Sync it like any other note.

The MCP server instructs AI clients to read this note before writing. These
conventions guide the AI; they are not enforced by the server, do not grant
write access, and do not override your explicit requests.

### 3. Configure GitHub OAuth and deploy MCP

1. Choose your MCP origin: `https://obsidian-mcp.<account-subdomain>.workers.dev`,
   using the same account subdomain as the sync server.
2. In GitHub **Settings → Developer settings → OAuth Apps**, create an
   [OAuth app](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app).
   Set its homepage to that origin and its callback to
   `https://obsidian-mcp.<account-subdomain>.workers.dev/oauth/github/callback`.
   Copy the client ID and generate a client secret.
3. Copy `apps/cloudflare-obsidian-mcp/wrangler.jsonc` to
   `apps/cloudflare-obsidian-mcp/wrangler.deploy.jsonc`. Set these `vars`:

   | Variable | Value |
   | --- | --- |
   | `GITHUB_CLIENT_ID` | Your OAuth app's client ID |
   | `MCP_PUBLIC_BASE_URL` | The MCP origin above, without `/mcp` |
   | `VAULT_DATABASE` | Your synced database name |
   | `GITHUB_ALLOWED_USER_IDS` | Your numeric GitHub account ID, not username |
   | `MCP_WRITES_ENABLED` | `false` for read-only access; `true` to allow writes |

   To find your account ID in a browser, open
   [the GitHub users API](https://api.github.com/users/YOUR_USERNAME), replacing
   `YOUR_USERNAME` in the URL with your GitHub username. Check that `login`
   matches your account and copy the number in `id` (not `node_id`).
   If you renamed the sync Worker, update `POUCH_DATABASES.script_name` too.
4. Copy `apps/cloudflare-obsidian-mcp/.dev.vars.example` to `.dev.vars` in that
   same directory and set `GITHUB_CLIENT_SECRET`. From the repository root:

   ```sh
   npm run deploy:mcp -- --secrets-file apps/cloudflare-obsidian-mcp/.dev.vars
   ```

See [MCP deployment](DEPLOY.md#deploy-the-mcp-worker) for resource configuration
and upgrades. `npm run deploy` deploys **both** Workers after both are configured.

### 4. Add the MCP URL to your AI product

Add a remote MCP server/custom connector with this URL:

```text
https://obsidian-mcp.<account-subdomain>.workers.dev/mcp
```

Sign in with your allowed GitHub account and approve the requested vault access.
You don't give the AI client your CouchDB password or GitHub client secret.
Give the MCP connector a distinctive name—I use **Folio**. Try asking it to
find and read a test note. With writes enabled, you can then ask “Please save
a summary of this chat in Folio”, and sync Obsidian to see the new note.

## Caveats

- **Use a test vault first.** Please don't move your active, important notes
  here yet. Keep an independent backup—for example, copy a vault from one
  device into a separate Dropbox or iCloud backup folder. A second live sync
  system on the same working folder is not a substitute for a backup.
- **MCP does not support encrypted vaults or obfuscated paths.** Sync-only use
  is expected to carry client-encrypted data because the server replicates documents without
  decrypting them, but encrypted client syncing has not been verified here.
  Offline backup extraction also currently requires an unencrypted,
  unobfuscated vault.
- **Backups go to your Cloudflare R2 bucket.** Defaults retain 30 daily,
  8 weekly, and 24 monthly recovery points. These are in the same account as
  your server; keep a separate copy and test recovery. See
  [Backup and recovery](docs/backup-recovery.md).
- **Compatibility is focused on LiveSync.** Large vaults and unusual settings
  need more real-world testing. See [Compatibility and limits](COMPATIBILITY.md)
  for supported operations and size constraints.

## Built on LiveSync

Most of the vault handling builds on
[LiveSync Commonlib](https://github.com/vrtmrz/livesync-commonlib).
Storage uses PouchDB with a
[SQLite Durable Object adapter](https://github.com/robince/pouchdb-adapter-sqlite/tree/cloudflare-do-adapter/packages/pouchdb-adapter-cloudflare-do).
This project brings that storage to Cloudflare and adds the separate MCP
interface. Thanks to the upstream authors for making it possible.

For implementation details, local development, and test commands, see
[Development and architecture](docs/development.md).
