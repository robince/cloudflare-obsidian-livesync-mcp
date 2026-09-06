# Backup and recovery

Each deployment backs up one vault database to its private R2 bucket. Backups
contain retained database history, chunks, attachments, deletions, and local
LiveSync metadata. Search indexes are rebuilt. Files or settings which were
never synchronised are not included.

R2 encrypts stored objects with Cloudflare-managed keys. Authorised downloads
are readable; there is no separate archive password or recovery key. Keep
backups and extracted files private. Same-account R2 does not protect against
loss of the Cloudflare account; download copies separately if that is required.

## Enable backups

New deployments provision `BACKUP_BUCKET` automatically through Wrangler. R2
must be enabled for the Cloudflare account; complete any account/billing setup
Cloudflare requests. No public bucket URL, S3 credentials, or MCP setup is needed.

The storage configuration uses:

| Variable | Default | Meaning |
| --- | --- | --- |
| `BACKUP_DATABASE` | `vault` | The single LiveSync database to protect |
| `BACKUP_ENABLED` | `true` | Include R2 backup resources at deployment and enable scheduled backups |
| `BACKUP_DAILY` | `30` | Daily recovery points |
| `BACKUP_WEEKLY` | `8` | Weekly recovery points |
| `BACKUP_MONTHLY` | `24` | Monthly recovery points |

Set `BACKUP_DATABASE` to the database name entered in LiveSync. A missing
database produces an error; the backup job does not create an empty database.
Deploying with backups disabled also omits the R2 binding, so manual R2
backup and restore operations are unavailable.

### Deploy without R2

Set `vars.BACKUP_ENABLED` to the string `"false"` in the ignored
`wrangler.deploy.jsonc`, then run `npm run deploy:storage`. For dev, set
`env.dev.vars.BACKUP_ENABLED` and run `npm run deploy:storage:dev`.

The deployment script omits `BACKUP_BUCKET` and clears the backup cron schedule
in a temporary configuration. Your saved binding and schedule stay intact.
Set the flag back to `"true"` and redeploy to enable backups again; activate R2
first if necessary. Existing bucket contents are not deleted when disabling
backups. Keep the same bucket name when re-enabling to retain access to them.

Sync and MCP work without R2. Manual R2 backup and restore operations require
the binding, so keep independent backups while it is disabled.

Use the npm deployment commands: calling `wrangler deploy` directly bypasses
this configuration step. Changing the flag only in the Cloudflare dashboard
stops scheduling in the running Worker but does not remove its R2 binding or
cron triggers; edit the deployment file and redeploy instead.

### Schedule and retention

The hourly cron (`0 * * * *`) checks whether a successful backup exists for
today. From 03:00 UTC, it attempts one if needed and retries failures on later
checks. It does not create hourly backups. Source writes briefly receive HTTP
503 with `Retry-After: 60`, or an MCP unavailable result. An export exceeding
60 seconds is abandoned, writes resume, and existing recovery points remain.

Retention keeps the latest successful backup for each of the latest 30 distinct
UTC dates, 8 ISO weeks, and 24 calendar months. Overlap is stored once. Pruning
runs only after a successful backup, so a prolonged outage does not expire all
recovery points. Abandoned export parts are cleaned after seven days during a
successful run. Do not add an age-based bucket lifecycle rule which deletes
completed recovery points independently of this policy.

Full backups include retained history and may be larger than the current vault.
This policy keeps at most 62 selected backups once pruning completes; it does
not promise free R2 storage. Check Cloudflare's current pricing for your usage.

### Upgrade an existing deployment

Copy these additions from `wrangler.jsonc` into your ignored
`wrangler.deploy.jsonc`: the `BACKUP_BUCKET` entry in `r2_buckets`, the cron
trigger, and the five variables above. Use the intended vault name. Deploy with
`npm run deploy:storage`; Wrangler provisions the bucket and inherits the existing
binding on subsequent deployments when `bucket_name` remains omitted. Keep the
same Worker name and binding. If you explicitly set `bucket_name`, retain it on
subsequent deployments.
Do not overwrite other account-specific settings with the template.

The package requires Node 22.18.x–22.x or 24.11.0 and later for the operator CLI and Wrangler
4.45 or later for automatic provisioning. Use `npm ci` to obtain the tested
lockfile version. The optional MCP Worker needs no R2 binding.

## Operator commands

Use an ignored environment file containing `COUCHDB_USERNAME`,
`COUCHDB_PASSWORD`, `BACKUP_URL` (the HTTPS Worker origin), and `BACKUP_DATABASE`.
Do not put credentials in command arguments, URLs, or tracked configuration.
The commands below assume these variables have been loaded into the environment.
Alternatively invoke `node --env-file=.dev.vars --experimental-strip-types
scripts/backup.mjs` in place of `npm run backup --`.

```sh
npm run backup -- status
npm run backup -- create
npm run backup -- list
npm run backup -- verify --id BACKUP_ID
npm run backup -- download --id BACKUP_ID --out /private/tmp/vault-backup
npm run backup -- verify --dir /private/tmp/vault-backup
npm run backup -- extract --dir /private/tmp/vault-backup --out /private/tmp/recovered-vault
```

Output directories must not already exist. Downloads contain `manifest.json`
and compressed parts; preserve the whole directory. Offline `verify` and
`extract` require no network or Cloudflare credentials.

Extraction writes files beneath `recovered-vault/vault` and a separate
`extraction-report.json`. It extracts current winning files, not every retained
revision. Conflicts, missing chunks, unsupported entries, and unsafe/colliding
paths appear in the report and give exit code 2. Missing files are never silently
reported as a complete recovery. Binary attachments, inline chunks, and Commonlib
compression are supported for the current unencrypted, unobfuscated profile.

`status` reports the latest attempt, success, size, error, running state, and
whether the last success is older than 26 hours. A never-backed-up vault is
reported overdue. Review Worker logs for scheduled failures; v1 does not send
notifications. A successful upload proves archive integrity, not that every
LiveSync reference has its chunks: use extraction and a restore rehearsal too.

## Restore through LiveSync

A restore reads a completed backup from the deployment's R2 bucket into an
**unused database name**. It refuses an existing or previously used target;
it never replaces the original database. A failed import remains unavailable
until an explicit restart succeeds.

1. Stop editing and suspend LiveSync on every device. Preserve readable local
   copies before choosing to discard unsynchronised changes.
2. List and verify the intended backup, then restore:

   ```sh
   npm run backup -- restore --id BACKUP_ID --target vault-restored
   ```

   Only after a failed attempt, use the same command with `--restart` to discard
   the incomplete target import and try again. The original database is untouched.
3. Verify the restored database using a disposable client before normal cutover.
   Restore preserves revision history but applies LiveSync's remote-rebuild
   milestone: locked, with no previously accepted devices. This is the plugin's
   compatibility convention, not a server access-control lock.
4. On each device change the LiveSync database name to `vault-restored`, then
   use **Reset Synchronisation on This Device**, or close Obsidian and create
   `flag_fetch.md` (`redflag3.md` is also supported) at the vault root.
5. In the retrieval dialogue choose **Overwrite all with remote files**, then
   **Delete local files if not on remote**. These choices discard local edits
   and local-only files within the plugin's synchronisation scope. Do not choose
   newer-wins or bypass the rebuild warning for this recovery procedure.
6. Let the plugin finish downloading and applying the files. If retrieval fails,
   keep its fetch flag and suspended state and resolve the error before retrying.
   The new database URL avoids reusing an unfinished fetch position associated
   with the original server database. Do not restore a different snapshot into
   an in-progress target.
7. If LiveSync presents a device compatibility review, review it and use its
   **Resume synchronisation** action after confirming compatible plugin versions.
   Check notes, attachments, and conflicts, then perform a two-device round-trip.
8. Set `BACKUP_DATABASE` to `vault-restored` in the storage deployment configuration,
   redeploy storage, and create/verify its first backup. If MCP is enabled, set
   its `VAULT_DATABASE` to the same name and redeploy MCP.
9. Keep the old database and downloaded backup until recovery is verified.
   Deleting the old database is a separate operator decision.

The restore API does not upload a local archive or perform an in-place rollback.
For loss of the entire account, offline extraction still recovers ordinary vault
files, which can seed a new LiveSync deployment using the plugin's existing
server-rebuild workflow. Deployment configuration and secrets must be preserved
separately from vault backups.

## Format and verification

Format 1 targets the pinned SQLite adapter `1.1.2-cloudflare-do.0`. It stores
allowlisted table rows in gzip JSONL parts, at most 4 MiB uncompressed per part,
with explicit binary encoding, per-part SHA-256 hashes, row counts, and source
identity. Restore never executes SQL from an archive and rejects unsupported
formats. Do not upgrade the adapter without keeping a tested reader for retained
backups or documenting the required older restore version.

Run `npm run test:backup` for database round-trip, maintenance/failure handling,
retention, and offline extraction checks. The full `npm test` includes these
checks alongside protocol and semantic regressions.

See [the staging verification record](backup-staging-results.md) for measured
sizes, write pauses, real-client recovery results, and the tested limits.

Disposable remote validation:

```sh
node scripts/staging/backup-prepare.mjs
npx wrangler deploy --config .wrangler/backup-staging/storage.json --secrets-file .wrangler/backup-staging/secrets.json
# Set STAGING_BACKUP_URL to that deployment's printed URL.
node --experimental-strip-types scripts/staging/backup-smoke.mjs
# Set STAGING_LIVESYNC_ROOT to the built checkout pinned in scripts/staging/config.mjs.
node --experimental-strip-types scripts/staging/backup-clients.mjs
```

The preparation command refuses to overwrite existing staging configuration.
The smoke test refuses a mismatched Worker origin and uses synthetic data only.
It records measurements and private cleanup references in ignored files.
Real-client tests use generated vaults and isolated profiles. No normal vault or
production deployment is changed. Remove the disposable Worker, database, and
bucket after inspecting the results; do not leave its scheduled trigger running.
