# Disposable-vault conflict staging

This is a release acceptance gate, not a unit-test replacement. Never connect
normal vaults, phones, or an existing test environment to this workflow.

## Prepare isolated resources

Run `node scripts/staging/prepare.mjs` once. It exclusively creates ignored,
private files under `.wrangler/conflict-staging/`: unique Worker/database names,
separate storage and MCP configurations, and a random Basic-auth secret file.
It does not deploy anything. Repeating it refuses to replace an active run.

Deploy with the generated configurations, never the default production names:

```sh
npx wrangler deploy --config .wrangler/conflict-staging/storage.json --secrets-file .wrangler/conflict-staging/storage-secrets.json
```

Set the generated MCP origin with `node scripts/staging/prepare.mjs --origin
<actual-staging-https-origin> <workers-dev-account-subdomain>`, using the
generated MCP Worker name and the account's verified workers.dev subdomain.
Create a separate GitHub OAuth application with this origin as its homepage
and `<origin>/oauth/github/callback` as its callback. Set `GITHUB_CLIENT_ID` in
the generated MCP config's `vars`, and only the staging account in
`GITHUB_ALLOWED_USER_IDS`. Save only `GITHUB_CLIENT_SECRET` in the ignored
`.wrangler/conflict-staging/mcp-secrets.json`. Deploy MCP and its secret together:

```sh
npx wrangler deploy --config .wrangler/conflict-staging/mcp.json --secrets-file .wrangler/conflict-staging/mcp-secrets.json
```

Its binding targets only the generated storage Worker. Wrangler provisions a
dedicated OAuth KV namespace; retain its generated ID in the ignored config.
Writes start disabled. Observability is disabled on these disposable copies to
avoid retaining fixture content in remote logs. Do not print secrets or paste
them into chat.

Use `node scripts/staging/authorize.mjs read` for the real DCR/PKCE/GitHub
consent flow. It provides a consent URL and listens on a temporary localhost
callback; the token is saved privately in ignored `tokens.json`. The helper
never prints the token. Verify the read-only deployment before changing
`MCP_WRITES_ENABLED` to `true`, redeploying this MCP copy, and authorising a
separate write grant with `node scripts/staging/authorize.mjs write`.

## Prepare the real clients

Create a temporary detached worktree of `../obsidian-livesync` at
`f5f7aab11f03f62c6946d2fa296c50bb5df5b2a4` (Self-hosted LiveSync 1.0.21).
Do not switch the developer's normal checkout. Run `npm ci` and `npm run build`
in that worktree, and set `STAGING_LIVESYNC_ROOT` to its absolute path.

The runner reuses the pinned upstream `@vrtmrz/obsidian-test-session` wrappers:
two generated vaults, independent local PouchDBs, HOME/XDG directories, and
Electron user-data directories. Both are real Obsidian desktop clients on one
computer. Override `OBSIDIAN_BINARY`/`OBSIDIAN_CLI` only to select installed
executables. Shared-profile and arbitrary launch-argument overrides are refused.

```sh
node scripts/staging/run.mjs --check
node scripts/staging/run.mjs --verify-readonly
# After the write-enabled deployment and write grant:
node scripts/staging/run.mjs --run
```

`--check` checks the pinned worktree, built artefacts, configuration, and installed
executables. It does not validate OAuth tokens, launch clients, or write remotely.
`--run` refuses any existing database, even an empty one. It creates the new
database, lets the pinned plug-in establish its remote profile, and proves the
MCP binding by reading a random probe written through Basic-auth storage before
attempting any MCP mutation. Do not reuse a failed run's database: retain its
evidence and deliberately configure a fresh unique staging database.

Before OAuth is ready, `clients-smoke.mjs` verifies two independent real Obsidian
launches, and `sync-smoke.mjs` verifies a real A-to-B-to-A round-trip against a
different freshly named database on the isolated storage Worker. Invoke these
with the pinned worktree's `tsx` loader, as used by `run.mjs`. Neither is a substitute
for the authenticated conflict matrix. The project-owned session wrapper handles
the current Obsidian external-link confirmation only when its displayed path
exactly matches the generated test vault; it never selects “Don't ask again”.
It also prefers the actual `app://obsidian.md` renderer over empty debugger
targets, only on this process's registered isolated-client ports. The pinned
upstream plugin and merge implementation are not patched. Initial setup publishes
preferred tweaks through the real plugin's `setPreferredRemoteTweakSettings`.

## Automated matrix

- Normal MCP create/edit/append/delete propagates to both vaults; a stale CAS
  reports `revision_conflict`.
- Two offline file-API edits generate independent branches through the actual
  plug-in and replicator. Raw revision leaves are inspected before MCP runs.
- Safe non-overlapping edits and byte-identical edits reconcile without applying
  the requested append. A fresh read and deliberate retry then converge.
- Overlap, delete-versus-edit, and independent creates remain unchanged under
  MCP reads/writes. The runner opens the normal Obsidian conflict dialogue,
  captures it, and chooses its visible **Concat both** action for these fixtures.
- Three live versions use an offline snapshot of generated client A's vault
  **and isolated profile**. Only stopped generated directories are restored;
  the later A copy is retained in the private evidence directory. A two-edit
  third branch ensures it is the database winner. Commonlib must make one safe
  pairwise step, then leave the remaining manual pair untouched until Obsidian
  resolves it. No forced remote revision insertion is used for acceptance.
- Differing one-pixel GIFs remain conflicted under MCP attachment reads. Full
  Obsidian applies its normal binary policy; both clients must receive the result.
- Read-only MCP grants cannot trigger reconciliation.

Assertions use actual vault contents, remote revision leaves, and structured
MCP results. Logs alone are not pass criteria. Both processes are stopped before
their generated vaults/profiles are disposed. Failure to stop a process preserves
its directories. Private backups and screenshots remain in the reported temporary
evidence directory; treat them as sensitive because profiles contain credentials.
The JSON report retains only scenario names, counts, codes, and content hashes.

## Additional mandatory operational gates

The matrix report deliberately lists these as pending until actually performed:

1. Disable staging MCP writes and redeploy. Run `--verify-readonly` using the
   previously issued write token: writes must be absent and denied, reads work.
2. Run `node scripts/staging/revoke.mjs write` to revoke the staging access token
   through the provider's RFC 7009 endpoint. The old token must receive HTTP 401;
   a subsequent fresh consent must restore
   only the explicitly granted scopes. Do not substitute rotating the storage
   Basic password or merely hiding tools for token revocation.
   For fresh read-only consent, temporarily enable writes on the isolated MCP
   and run `node scripts/staging/verify-access.mjs scope`; this proves scope
   denial independently of the kill switch, successful reads, no mutation, and
   continued HTTP 401 for the revoked token. Restore writes-off immediately and
   run `node scripts/staging/verify-access.mjs disabled`.
3. Record the two staging Worker version IDs, roll back **only** the MCP copy,
   and perform a new Obsidian A-to-B edit. Repeat with the intended compatible
   storage rollback version. Confirm normal replication and final convergence.
   Never roll back a production Worker or another manual-test environment.
4. Review actual screenshots and the sanitised report. A preflight or smoke
   pass is not a two-client conflict acceptance pass.

Only after these gates pass should the checkpoint be labelled complete. Missing
credentials or interactive client access are a pause, never an assumed pass.

## Cleanup and recovery

Turn MCP writes off first. Keep the remote database and failed-run backups until
evidence has been reviewed. Remove only the exact generated Workers, their OAuth
KV namespace, and disposable databases after explicit cleanup approval. Remove
the temporary worktree using Git's worktree removal after the client processes
are stopped. Keep production identifiers, endpoints, credentials, and raw vault
content out of committed evidence. The raw CouchDB routes need no rollback to
continue syncing while MCP is disabled.
