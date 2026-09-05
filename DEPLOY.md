# Deployment

This guide deploys the Cloudflare PouchDB storage Worker to your own Cloudflare
account. The optional MCP Worker can be deployed alongside it after its GitHub
OAuth settings are configured.

## Deploy from this private repository

Cloudflare's Deploy to Cloudflare button supports public repositories only. If
you have been added as a collaborator while this repository is private, deploy
with Wrangler instead:

1. Install Node.js 22 or later and clone the repository.

   ```sh
   git clone git@github.com:robince/cloudflare-obsidian-livesync.git
   cd cloudflare-obsidian-livesync
   npm ci
   ```

2. Copy the portable configuration and secret example. Edit only the deployment
   copy for your account; replace the password placeholder with a strong, unique
   password. Both local files are ignored by Git.

   ```sh
   cp wrangler.jsonc wrangler.deploy.jsonc
   cp .dev.vars.example .dev.vars
   ```

3. Sign in to the Cloudflare account where the Worker should run, then deploy
   the Worker and its secret together.

   ```sh
   npx wrangler login
   npm run deploy:storage -- --secrets-file .dev.vars
   ```

Wrangler opens Cloudflare authentication in a browser. On success, it provisions
the SQLite Durable Object, applies its migration, uploads `COUCHDB_PASSWORD` as
an encrypted Worker secret, and prints the deployed `workers.dev` URL.

You do not need to create a Cloudflare API token or copy an account ID, database
ID, or Durable Object ID.

## Deploy from a public repository

The current button targets the root storage Worker. It cannot configure and
deploy the optional MCP workspace at the same time. Cloudflare detects the
`deploy` script, but that script requires the ignored deployment configurations;
a fresh button deployment must override the deploy command with
`npx wrangler deploy --env ""` to use the committed storage template.
It presents the storage variables and password, not the MCP OAuth settings.
Use the Wrangler instructions below for MCP.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/robince/cloudflare-obsidian-livesync)

The source repository must be public for the button to work.

## Configuration

- `COUCHDB_PASSWORD` is the only required secret. Choose a strong, unique value
  and do not commit it.
- `COUCHDB_USERNAME` is a non-secret variable and defaults to `admin`.
- `CORS_ORIGINS` is a non-secret variable. Its committed default supports
  Obsidian desktop, mobile, and local development.

To change the password after deployment, run:

```sh
npx wrangler secret put COUCHDB_PASSWORD --config wrangler.deploy.jsonc
```

## Connect Obsidian LiveSync

Use these CouchDB settings after deployment:

- URI: the `workers.dev` URL printed by Wrangler, without a database suffix;
- database name: a lower-case CouchDB name such as `vault`;
- username: `admin`, unless you changed `COUCHDB_USERNAME`;
- password: the value you set for `COUCHDB_PASSWORD`.

Future deployments use `npm run deploy:storage`; the existing secret is
preserved without requiring a local secret file.

## Configuration files

Each Worker keeps a committed `wrangler.jsonc` for portable defaults and local
tests. Copy it to an ignored `wrangler.deploy.jsonc` in the same directory for
actual deployments. The deploy scripts explicitly select the ignored copies
and fail if they are missing. Tests, type generation, and CI dry runs use the
committed templates.

Deployment files contain non-secret configuration: Worker names, public URLs,
vault names, GitHub Client IDs, allowlists, write settings, and provisioned
resource IDs. Keep passwords and client secrets in ignored `.dev.vars` files
or the existing Cloudflare secret store.

Back up deployment files separately: Git clones do not restore them. These are
full configuration copies, so carry shared code-entry, binding, migration, and
compatibility changes into the deployment copies when updating the templates.
There is no custom configuration-merging step.

For automated deployment, supply the deployment file to the build environment
before running the deploy scripts. Do not commit account-specific values merely
to make a Git-based build work.

## Default and development deployments

The default Workers are `obsidian-sync` and `obsidian-mcp`, with no production
suffix. Each configuration also defines an optional `env.dev` for
`obsidian-sync-dev` and `obsidian-mcp-dev`. One checkout supports both.

| Command | Target |
| --- | --- |
| `npm run deploy` | Both default Workers, storage first |
| `npm run deploy:storage` | Default storage only |
| `npm run deploy:mcp` | Default MCP only |
| `npm run deploy:dev` | Both dev Workers, storage first |
| `npm run deploy:storage:dev` | Dev storage only |
| `npm run deploy:mcp:dev` | Dev MCP only |

All of these commands use the ignored deployment copies. Default commands
explicitly select the top-level configuration (`--env ""`); dev commands select
`--env dev`. Configure default values at the top level and dev values under
`env.dev`. Do not pass `--env` to the aggregate npm scripts.

Wrangler does not inherit variables or resource bindings into named environments.
Keep the complete dev `vars`, Durable Object bindings, and OAuth KV
bindings in `env.dev`. Dev MCP must point at dev storage through
`POUCH_DATABASES.script_name`. Use separate KV namespaces for each
environment; retain provisioned IDs in the corresponding configuration.

Configure each MCP environment's public URL, vault database, allowed user IDs,
and write setting. Register a separate GitHub OAuth app for dev, with its own
client ID, secret, and callback URL. Default MCP remains optional.

For first dev deployment, create ignored `.dev.vars.dev` files at each Worker
root from the corresponding `.dev.vars.example`, then run:

```sh
npm run deploy:storage:dev -- --secrets-file .dev.vars.dev
npm run deploy:mcp:dev -- --secrets-file apps/cloudflare-obsidian-mcp/.dev.vars.dev
```

These files are not uploaded automatically: `--secrets-file` installs their
secrets on the selected Worker. Later deployments preserve the installed secrets.
To update one interactively, include both the config and environment:

```sh
npx wrangler secret put COUCHDB_PASSWORD --config wrangler.deploy.jsonc --env dev
```

Existing deployments should retain their current Worker names, resource IDs,
URLs, and cross-Worker binding targets in `env.dev` if they are now your dev
installation. A new Worker name creates separate Durable Object storage; it does
not rename or copy the old vault. Set up the new default vault through LiveSync.
Do not overwrite existing deployment files by copying the templates again.

## Deploy the MCP Worker

The MCP Worker connects directly to the storage Worker's Durable Object. It
does not need the CouchDB URL or password. Before its first deployment:

1. Reuse the account subdomain from the existing storage Worker URL. The MCP
   origin is `https://obsidian-mcp.<account-subdomain>.workers.dev`.
   Register a GitHub OAuth app with this homepage and the same origin plus
   `/oauth/github/callback` as its callback URL.
2. Create the local deployment configuration:

   ```sh
   cp apps/cloudflare-obsidian-mcp/wrangler.jsonc apps/cloudflare-obsidian-mcp/wrangler.deploy.jsonc
   ```

   Set its non-secret `vars`: `GITHUB_CLIENT_ID`, `VAULT_DATABASE`,
   `MCP_PUBLIC_BASE_URL`, `GITHUB_ALLOWED_USER_IDS`, and `MCP_WRITES_ENABLED`.
   Use `false` for an initial read-only test. If you rename the storage Worker,
   update this file's `POUCH_DATABASES` binding `script_name` to match.
3. Copy `apps/cloudflare-obsidian-mcp/.dev.vars.example` to
   `apps/cloudflare-obsidian-mcp/.dev.vars` and fill in only `GITHUB_CLIENT_SECRET`.
4. Deploy the Worker and secret together:

   ```sh
   npm run deploy:mcp -- --secrets-file apps/cloudflare-obsidian-mcp/.dev.vars
   ```

For a brand-new account, configure its workers.dev subdomain when deploying
storage first, then use that subdomain for MCP. An existing storage deployment
already supplies the suffix, so MCP needs no preliminary deployment.

Wrangler provisions OAuth KV on first deployment and reuses the existing
`OAUTH_KV` binding on subsequent deployments. Keep only `{ "binding": "OAUTH_KV" }`
in the committed template. Retain the namespace ID Wrangler provisions in the
ignored deployment file so subsequent deployments explicitly target that OAuth
store. For an existing deployment, copy its current ID rather than creating a
new namespace. The ID is non-secret but account-specific.

Generate types with `npm run types`; generation and checks use
`--strict-vars=false` to avoid literal URL, database, login, and client ID types.

After the initial deployments, use `npm run deploy:mcp` for MCP alone or
`npm run deploy` for both Workers in dependency order. Existing secrets are
preserved, so these commands do not require local secret files. Non-secret vars
come from the ignored deployment configurations; dashboard vars and `--keep-vars` are
unnecessary.

When migrating an existing deployment that stored `GITHUB_CLIENT_ID` as a
secret, set its public value in the ignored deployment file's `vars` and remove
`GITHUB_CLIENT_ID` from `secrets.required` in that file. Deploy them together.
Until the ID is available, omit it from `vars` and retain its existing required
secret binding; do not substitute a placeholder or delete the live secret first.

References: [workers.dev URLs](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/),
[configuration best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/),
and [Wrangler type generation](https://developers.cloudflare.com/workers/wrangler/commands/workers/#types).

For upgrades, replace the old login allowlist with immutable account IDs; an
absent/invalid ID allowlist denies access, with no username fallback. Obtain and
verify IDs with `gh api user --jq '{login, id}'` and the GitHub users API. See
[contract 5 migration](apps/cloudflare-obsidian-mcp/README.md#upgrade-to-contract-5)
for token compatibility and configuration examples.
