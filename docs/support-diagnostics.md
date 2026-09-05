# Diagnostics and usage reports

Run this utility from your checkout after `npm ci` and `npx wrangler login`.
It uses your existing Wrangler credentials. Node must satisfy this project's
engine requirement; the utility requires Wrangler 4.127 or newer within v4
(tested with 4.127.1). It does not download Wrangler or deploy anything.

## Collect a period

```sh
npm run diagnostics -- report --storage-worker my-sync --since 24h --plan free
npm run diagnostics -- report --storage-worker my-sync --mcp-worker my-mcp \
  --from 2026-09-05T09:00:00Z --to 2026-09-05T10:00:00Z --plan paid
```

Use the actual deployed Worker name, which may differ from the template name.
`report` includes platform usage and available historical diagnostic/error events.
It includes safe successful events too, to explain what led up to failures.
The default window is 24 hours; `--since` accepts minutes (`30m`), hours (`24h`)
or days (`7d`). Explicit timestamps must be UTC. The maximum window is 31 days,
which does not imply Cloudflare retains logs or analytics for that entire period.

If you belong to multiple accounts, supply `--account-id ID`. The environment's
`CLOUDFLARE_ACCOUNT_ID` is also supported. The storage namespace is resolved from
the deployed `POUCH_DATABASES` / `PouchDatabase` binding. An explicit
`--namespace-id ID` must be bound to that Worker. Namespace measurements include
all objects in that namespace; they are not guaranteed to describe one vault.
Specify MCP explicitly; other projects are not queried for usage.

Choose `--plan free` for quota comparisons or `--plan paid` for usage valuation.
Omit the option to collect usage without pricing assumptions.

## Reproduce a problem live

```sh
npm run diagnostics -- capture --storage-worker my-sync --duration 120
```

MCP and account options also apply. The duration defaults to 120 seconds and is
limited to one hour. Capture begins by starting Wrangler JSON tails. A message
confirms the connection when the first event arrives; an empty capture is marked
unconfirmed. Reproduce the problem during the window. Ctrl-C stops child processes
and writes an explicitly partial bundle. No usage cost is inferred from tail
request durations; run `report` afterward for platform usage.

## Review and share

The utility creates a new `diagnostics-<timestamp>` directory, or the new directory
specified by `--out`. It never overwrites an existing directory.

- `summary.md`: readable usage, cost/quota interpretation, errors and coverage.
- `usage.json`: metric values, hourly buckets, units, sources and cost assumptions.
- `events.jsonl`: sanitized operation and error metadata.
- `manifest.json`: window, format version and status for each source.

Review these files before attaching them manually to a support request. Nothing
is uploaded automatically. Exit 0 means collection finished; exit 2 means partial
or unavailable sources; exit 1 means invalid arguments or an output/setup failure.
A finished collection is still subject to Cloudflare sampling and retention.

The export allowlist excludes content, paths, identifiers, URLs, headers, tokens,
SQL, arbitrary log messages and stacks. Unrecognized errors retain only safe
platform metadata. Counts, timings and the chosen dates reveal activity patterns:
these are content-free reports, not anonymous reports. No vault documents are
fetched. Source logging improvements affect future deployments only; filtering
cannot remove logs already stored in Cloudflare.

Wrangler credentials are obtained through `auth token --json` into memory, never
printed. Child processes set `WRANGLER_WRITE_LOGS=false`, disable Wrangler telemetry
and remove output-file environment overrides. Raw API/tail records are not saved.
The report is bounded to 50,000 exported events, 100 log pages per Worker, 8 MiB
per API response, 250 API calls and a ten-minute API collection budget. Reaching
limits produces explicit partial coverage rather than an unbounded export.

## Authentication and missing data

The default is the same credential used by Wrangler deploy. Successfully deploying
does not guarantee permission to query historical logs.

- `wrangler_auth_failed_run_wrangler_login`: run `npx wrangler login` interactively.
- `permission_denied` for historical logs: the query API requires **Workers
  Observability Write**, despite this utility only querying data. Refresh the
  Wrangler login if it predates that scope. If your OAuth grant still lacks it,
  use a token for the selected account with that permission via
  `CLOUDFLARE_API_TOKEN`; Wrangler will resolve it automatically.
- Analytics access requires **Account Analytics Read**. Worker binding discovery
  requires **Workers Scripts Read**; automatic account discovery also requires
  account-list access, otherwise specify `--account-id`.
- `api_http_404`: check the account and deployed Worker name.
- `api_query_failed_check_permissions_and_window`: check analytics permissions and
  try a shorter/recent period. Raw API error text is deliberately not exported.
- No records can mean inactivity, retention expiry, disabled logging, sampling or
  ingestion lag. The script never turns on logging automatically. New deployments
  use the project's existing observability configuration.

Unavailable metrics are not zero. A namespace without storage samples has unknown
storage usage. Recent buckets may be incomplete; rerun the same explicit window
once ingestion has settled. Old application versions provide fewer safe events.

## Interpreting efficiency and cost

DO duration comes from `durableObjectsPeriodicGroups.sum.duration` (GB-seconds).
CPU values are converted from microseconds to milliseconds. SQLite read/write
counters come from that dataset's `rowsRead` / `rowsWritten`, not legacy KV units.
Requests come from the DO invocation and Workers invocation datasets separately.
Storage uses the SQL namespace gauge's hourly maxima; the most recent bucket is
not an instantaneous current size. Byte-time storage charges are excluded because
hourly maxima alone do not establish average billable storage.

Equivalent active object-hours divide duration by the documented 0.128 GB billing
allocation and 3,600. They aggregate objects and do not represent exact lifecycle
transitions. The utility never adds overlapping request durations, reports an
inferred wake/sleep trace, or invents a single-vault occupancy percentage.

Long-poll ratios are observations from safe application events: completed polls
per hour, empty fraction, wait duration/reason and observed concurrent waits.
They may be sampled. CPU can be low while duration remains high. Returned changes
are replication records, not a count of user edits. Instrumentation adds no
persistent counters, background flush timers or alarms.

Paid reports value measured usage linearly at published overage rates checked
2026-09-05. This is a **subtotal, not an invoice**. Shared allowances may reduce
charges; billing-unit rounding may increase them. Subscription fees, storage
byte-time, R2, logs, tax and discounts are excluded. The 30-day projection assumes
unchanged workload and is unsuitable for initial imports or brief captures.
Free-plan reports compare the project's observed contribution to shared account
daily limits, split at midnight UTC; partial-day windows are explicitly labelled.

## Compare sync modes

Use a disposable vault/deployment with comparable observation windows:

1. All clients disconnected.
2. One idle live-sync client.
3. One idle periodic-sync client.
4. Controlled edits with each mode.
5. Two simultaneous clients.
6. Initial import, recorded separately.

Keep the workload and background backup/MCP activity comparable. Record the mode,
client count and release locally. Query the same explicit windows after ingestion
settles. Compare duration, requests, reads/writes and estimated cost alongside
client-measured edit-to-visible latency. Server wait time is not end-to-end latency.
Run baseline measurements without live tail attached and compare instrumentation
on/off separately. Do not claim savings from uncontrolled usage windows.

## Validation status

Local collector tests cover privacy injection, pagination, malformed streaming
JSON, credential error handling, costing, units and live child cleanup. Worker
regressions cover replication/backup and stream completion/cancellation. MCP tests
cover metadata-only logging.

Read-only smoke testing on 2026-09-05 verified Wrangler credential reuse and all
platform metric queries against the existing deployment. Historical query access
was denied by the available credential. Historical response parsing/pagination
therefore has fixture coverage, not successful authenticated end-to-end validation.
No instrumentation deployment, dashboard reconciliation or controlled multi-client
staging measurements have been performed for this feature. Those remain release
validation work; no efficiency or savings result is claimed.

References: [Wrangler authentication](https://developers.cloudflare.com/workers/wrangler/commands/general/),
[DO analytics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/),
[historical query API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/),
[DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).
