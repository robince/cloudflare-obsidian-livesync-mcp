# Deployment

This guide deploys the Cloudflare PouchDB storage Worker to your own Cloudflare
account. It does not deploy the optional MCP Worker under
`apps/cloudflare-obsidian-mcp`.

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

2. Create the local secrets file and replace its placeholder with a strong,
   unique password. This file is ignored by Git.

   ```sh
   cp .dev.vars.example .dev.vars
   ```

3. Sign in to the Cloudflare account where the Worker should run, then deploy
   the Worker and its secret together.

   ```sh
   npx wrangler login
   npx wrangler deploy --secrets-file .dev.vars
   ```

Wrangler opens Cloudflare authentication in a browser. On success, it provisions
the SQLite Durable Object, applies its migration, uploads `COUCHDB_PASSWORD` as
an encrypted Worker secret, and prints the deployed `workers.dev` URL.

You do not need to create a Cloudflare API token or copy an account ID, database
ID, or Durable Object ID.

## Deploy from a public repository

If this repository becomes public, use the button below. Cloudflare will copy
the repository to your GitHub account, prompt for the required password, and
deploy it with Workers Builds.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/robince/cloudflare-obsidian-livesync)

The button will not work while the source repository is private, even for an
invited collaborator.

## Configuration

- `COUCHDB_PASSWORD` is the only required secret. Choose a strong, unique value
  and do not commit it.
- `COUCHDB_USERNAME` is a non-secret variable and defaults to `admin`.
- `CORS_ORIGINS` is a non-secret variable. Its committed default supports
  Obsidian desktop, mobile, and local development.

To change the password after deployment, run:

```sh
npx wrangler secret put COUCHDB_PASSWORD
```

## Connect Obsidian LiveSync

Use these CouchDB settings after deployment:

- URI: the `workers.dev` URL printed by Wrangler, without a database suffix;
- database name: a lower-case CouchDB name such as `vault`;
- username: `admin`, unless you changed `COUCHDB_USERNAME`;
- password: the value you set for `COUCHDB_PASSWORD`.

Future deployments can use `npx wrangler deploy`; the existing secret is
preserved. You can optionally connect the Worker to this private GitHub
repository under **Worker > Settings > Builds** in the Cloudflare dashboard for
automatic deployments. The Cloudflare Workers and Pages GitHub app must be
granted access to the repository.

