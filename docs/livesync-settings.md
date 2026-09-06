# LiveSync settings

## Obsidian LiveSync

Use these CouchDB settings in LiveSync:

- URI: the deployed Worker URL, without a database suffix;
- database name: a lower-case CouchDB name such as `vault`;
- username: the configured `COUCHDB_USERNAME` (`admin` by default);
- password: `COUCHDB_PASSWORD`.

The endpoint supports LiveSync's setup and configuration checks. Leave
LiveSync's custom chunk size at its default (`0`, approximately 100 KB chunks).
Durable Object SQLite has a hard 2 MB maximum for any single string or BLOB;
this service rejects documents above 1.8 MB and attachments above 900 KB to
preserve room for PouchDB metadata and binary-string encoding. The emulated
CouchDB configuration values exist for LiveSync's CouchDB-specific setup check
and do not raise that Cloudflare limit.

The default LiveSync chunking is comfortably within the limit. Large custom
chunk-size values intended for a conventional CouchDB server are not compatible.

### Recommended sync mode

Start with **LiveSync** in Self-hosted LiveSync's **Synchronisation Method**
settings on every device. I've had better luck with this mode.

Once syncing is working, you can try **Periodic and Events** to reduce the
time the server stays awake. Use these settings if you switch:

| Setting | Recommended value |
| --- | --- |
| Sync Mode | Periodic and Events (may be labelled Periodic Sync) |
| Periodic Sync interval | **60 seconds** |
| Sync on Save | Enabled |
| Sync on Editor Save | Enabled |
| Sync on Startup | Enabled |
| Sync on File Open | Enabled |
| Sync after merging file | Enabled |

These settings trigger finite CouchDB syncs when you work with files and every
minute while periodic replication is running. Remote changes, including MCP
edits, arrive on the next sync rather than immediately. If editing triggers too
many syncs, increase **Minimum interval for syncing** to space out automatic
event-triggered syncs.

Finite syncs let the Durable Object become idle and eligible for hibernation
between requests. Continuous **LiveSync** also works, but its long-poll requests
can keep the object awake even when no notes change. Cloudflare meters this
awake duration separately from CPU usage; idle objects eligible for hibernation
do not incur duration charges. See
[Durable Object billing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

Apply these settings on **every device connected to the same database**. Sync
preferences are saved locally for each vault installation and do not propagate
through ordinary note sync. The optional **Sync settings via markdown** feature
can share configuration, but requires separate setup. A client left in continuous
LiveSync mode can keep the shared object awake. Other requests or background work
can also delay sleep; a 60-second interval does not guarantee 60 seconds asleep.

Changing sync mode keeps the same CouchDB URL, database, and credentials; it does
not require a vault rebuild or backend deployment.

