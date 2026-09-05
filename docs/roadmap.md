# Forward roadmap

Direction agreed 2026-09-05: prioritize an open-source LiveSync endpoint that
individuals can deploy into their own Cloudflare free account. MCP is optional.
Managed hosting remains a possible later offering, not the next milestone.

Keep the existing foundation: one database per SQLite Durable Object, PouchDB
replication, Commonlib file semantics, and a separate MCP Worker bound to the
deployment's vault storage. Preserve revision-checked writes and conservative
conflict handling. [MCP_PLAN.md](../MCP_PLAN.md) retains implementation history
and acceptance gates; this document describes future priorities.

## 1. Close reliability and security findings — implemented locally

- Bound `_changes` work before materializing the backlog, preserving filtered
  paging/checkpoint semantics. Cover `open_revs=all`, zero/invalid limits, and
  selector filtering with conflicting leaves in regression tests.
- Validate conflict → chunk cleanup → reconstruction of retained versions.
  Define safe retention before adding automatic garbage collection; the current
  retained-revision reference view protects conflict leaves and readable ancestors.
- Authorize immutable GitHub user IDs, improve consent with client destination,
  vault identity and attachment permissions, and provide useful MCP text results
  alongside `structuredContent`.

Exit: focused regressions and existing checks pass; ordinary replication and
guarded MCP writes retain their current behaviour.

## 2. Prove the free-tier operating envelope

- Measure initial sync, idle live sync, periodic sync, search rebuilds and
  multi-device use on a disposable deployment. Record request counts, duration,
  SQL reads/writes, physical storage and user-visible latency.
- Exercise large chunk collections, interrupted sync, restart/reconnect,
  desktop visibility changes and mobile suspend/resume.
- Document tested vault sizes and recommended client settings, including the
  difference between live and periodic sync. Report quota exhaustion clearly.
- Add search progress and missing-chunk diagnostics; avoid requiring blind
  retries when an orphaned note blocks the index.
- Write and test backup/export and restore instructions, including reconnecting
  clients with existing revisions and checkpoints. Platform recovery alone is
  not an end-to-end LiveSync recovery procedure.

Exit: a reproducible free-tier setup with measured limits and a tested recovery
path. Do not promise that every vault or initial import fits the free tier.

## 3. Make the open-source deployment approachable

- Choose an explicit project licence and prepare the public repository, keeping
  reusable configuration separate from personal deployment values.
- Make storage-only deployment the shortest path: deploy, set credentials,
  configure LiveSync, verify a two-device round-trip.
- Offer MCP as a separate optional setup with clear GitHub OAuth instructions,
  read-only defaults and an explicit write opt-in. Avoid adding account/billing
  infrastructure to solve self-hosting onboarding.
- Publish troubleshooting, supported client versions and an upgrade/rollback
  procedure. Retain compatibility tests when upgrading Commonlib/PouchDB and
  upstream the small compatibility patches where practical.

Exit: a new user can deploy from the documentation without sibling repositories
or undocumented operator steps, and can independently enable MCP.

## 4. Expand MCP only where useful

Implemented locally: immutable-ID authorization, conservative cleanup, bounded
replication, JSON MCP results, typed frontmatter filters, text/property search
continuation, outlines and revision-checked line ranges. See the contract 5
checkpoint in [MCP_PLAN.md](../MCP_PLAN.md) and the MCP interface documentation.
Items 2 and 3 remain deferred; no remote deployment or interactive staging is
part of this implementation.

Before further MCP expansion, review actual Obsidian behaviour and settings:
attachment placement at vault root, beside a note, or in a configured folder;
relative links; filename/case handling; and move/rename effects on links and
attachments. Determine how settings would be obtained instead of assuming the
sync database exposes them. Attachment upload/relocation, backlinks, move/rename
tools, richer vault status/conventions, Canvas/Kanban and embeddings remain out
of scope.

Defer encrypted semantic MCP access. Opaque encrypted replication could become
a separately tested sync-only option; it is not yet a compatibility promise.
Service-held decryption keys and plaintext indexes would not provide
operator-blind E2EE. A user-controlled MCP bridge is a possible later approach.

## Deferred: managed SaaS

Possible offering: nominal-cost managed LiveSync with optional MCP, billed per
vault. Prefer evaluating a dedicated storage Worker + DO namespace per vault,
with MCP bound only to that vault's namespace. This provides binding-level
separation across vault deployments; separate Worker names sharing one namespace
do not provide the same boundary. A shared account/billing service need not have
vault-data bindings. Shared sync/MCP Workers remain a scale option, but require
explicit tenant authorization on both replication and MCP routes.

The main open question is cost. LiveSync mode maintains a remote long-poll while
active, including visible-but-idle desktop use; background replication is opt-in.
The pending request/timer prevents this DO from hibernating. Periodic mode uses
finite sync runs instead. Shorter long-poll timeouts alone do not solve duration
cost when the client reconnects immediately.

At the pricing checked on 2026-09-05, one continuously active DO represents about
11,059 GB-s/day, below the free account's 13,000 GB-s/day allowance. Beyond shared
paid allowances it represents roughly $4.15/month in duration usage for 30 days,
before other costs and billing rounding. This is an estimate, not a measured
per-vault bill or a fixed $5/vault fee. Concurrent devices sharing one DO share
its overlapping duration; separate hosted deployments do not receive separate
account allowances. The free plan also limits each DO to 1 GB of physical
storage, including revisions, chunks and derived indexes.

Revisit SaaS only after measuring realistic activity and support costs, or
identifying a compatible way to avoid continuously billable idle waiting. Check
current [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[limits](https://developers.cloudflare.com/durable-objects/platform/limits/) and
[hibernation rules](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
before making pricing or free-tier commitments.
