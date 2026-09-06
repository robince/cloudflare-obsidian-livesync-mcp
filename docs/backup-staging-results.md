# Backup recovery verification — 2026-09-05

The backup milestone was exercised on a disposable Cloudflare deployment and two
isolated Obsidian desktop profiles. Production configuration and personal vaults
were not used. The reproducible commands are in [the runbook](backup-recovery.md).

## Tested versions and recovery

- Wrangler 4.127.1, pinned SQLite adapter `1.1.2-cloudflare-do.0`, Commonlib 0.1.19.
- Real clients: LiveSync 1.0.21, checkout
  `f5f7aab11f03f62c6946d2fa296c50bb5df5b2a4`, the existing staging pin.
  The recovery convention was also reviewed in the sibling 1.0.24 source;
  that version was not substituted for the tested client build.
- First deployment provisioned the R2 bucket from a binding with no bucket name.
  Public bucket access was disabled. Subsequent deployments reused that bucket.
- An actual Cloudflare Cron Trigger completed an unattended backup. The staging
  trigger was temporarily accelerated to every minute, with no manual backup of
  its source database. The completion at 11:22 UTC reported 2,608 archive bytes,
  a 645 ms write pause, and current/non-overdue status. The production template
  retains its hourly check. Tail telemetry reported 16 ms DO CPU / 1,856 ms wall
  time for that backup; the final 10 MB restore reported 329 ms DO CPU.
  Subsequent scheduled checks skipped a duplicate daily backup. The disposable
  Worker, cron, databases, backup objects, and R2 bucket were deleted after testing.
- Remote backup, download, local hash verification, byte-for-byte vault extraction,
  and restore into an unused database name passed. A restored remote retained
  revisions and received the locked, empty-accepted-devices LiveSync milestone.
- Both stale clients recovered through the plugin's fetch/reset flow with
  remote-wins and delete-local-only choices. Newer local edits were replaced,
  local-only files removed, and locally deleted remote files recovered.
- The first client's streamed fetch was interrupted after valid rows. It saved
  a checkpoint and stayed suspended; restarting via `flag_fetch.md` completed
  recovery. An old database URL's fetch checkpoint did not block the new target.
  The normal compatibility-review action was used when prompted.
- After recovery, a new file from client A reached client B, and B's edit reached A.

## Measured size and pause

Synthetic fixture files were supplemented with independent random 100 KB chunk
strings to avoid giving gzip an unrealistically easy benchmark. These are
single-run observations, not throughput guarantees. Database bytes are physical
SQLite size; archive bytes are compressed parts (excluding the small manifest).

| Physical database bytes | Archive bytes | Parts | Write pause | Operator round trip |
| ---: | ---: | ---: | ---: | ---: |
| 98,304 | 2,607 | 1 | 944 ms | 1,994 ms |
| 1,110,016 | 758,092 | 1 | 604 ms | 2,918 ms |
| 10,174,464 | 7,552,584 | 3 | 2,477 ms | 4,687 ms |

Export buffers at most 4 MiB of encoded rows per part, with temporary compression
and encoding allocations. It does not materialise the whole database. Heap high
water, SQL operation billing, and a large-vault CPU envelope were not measured.
The largest remote database tested here was about 10 MB; larger vaults and a
free-tier operating envelope remain unproven. A single encoded row exceeding
4 MiB fails visibly rather than bypassing the bound.

The 60-second deadline was tested by advancing time during an upload: no
completion manifest appeared, the operation reported failure, and subsequent
writes succeeded. This is a deadline regression, not a claim that a physical
60-second export was benchmarked. Upload failures and blocked mutations were
also injected; old recovery points remained available.

## Automated checks

`npm run check`, `npm run types:check`, and `npm run test:all` passed. Backup
regressions cover retained/readable revisions, conflict leaves, tombstones,
local checkpoints, compressed and inline chunks, binary attachments, bounded
multipart export, blocked HTTP/RPC/MCP writes, failed upload, corrupt archive,
failed import/restart, and publication interrupted before status bookkeeping.

Offline checks cover Unicode paths and exact bytes, missing chunks, conflicts,
unsafe paths, symlink destinations, collisions, allowlisted tables, and integrity
failures. Retention checks cover overlapping selections, ISO week/year and month
boundaries, gaps between successes, and policy changes. Partial imports remain
inaccessible and failed exports release their write gate.

These tests establish the documented recovery procedure for the pinned client
and tested data. They do not establish broader search diagnostics, mobile
behaviour, initial-import limits, or free-tier cost measurements.
