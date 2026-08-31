# Residual issues (tutorial)

This is the tutorial from the 2026-08-31 review follow-up. It explains leftover
behaviour after the Commonlib session close and vault write work landed on
`livesync-mcp-access`.

Think of the vault Durable Object as **one room with one notebook**. Obsidian
and MCP take turns writing in it. The leftovers are about what happens at the
edges of that sharing, not about the room staying lit all night.

## 1. Listing is cheap to return, still expensive to compute

When you ask for “the next 50 files after this cursor”, the API correctly
returns at most 50.

What it does internally: start at the beginning of the vault, walk note
documents in id order, skip anything that is deleted, binary, or before the
cursor, and stop after 50 matches.

So page 1 of a 10,000-note vault is fine. Page 40 still re-walks everything
before that cursor. The **JSON** is bounded; the **work** is not.

Why we left it: LiveSync stores notes as CouchDB documents with no SQL index of
“markdown paths in folder X”. The cheap honest improvement is “walk until you
have `limit` matches,” which we did. The next step would be “start the scan at
the cursor id,” which is a bit more API work inside Commonlib.

You will feel this only on large vaults and deep pagination, not on a typical
personal vault’s first page.

## 2. Move is two writes, not one transaction

`move_file(from, to)` means:

1. Read `from`.
2. Write a new note at `to`.
3. Tombstone `from`.

There is no CouchDB/PouchDB “rename this document id” for LiveSync notes. The
path **is** the document id (when not obfuscated). A rename is “new id + mark
old id deleted.”

Consequences:

- If someone creates `to` between steps 1 and 2, we can overwrite it.
- If step 2 succeeds and step 3 fails, both paths exist until you clean up. The
  tool currently reports failure in that case, which is honest, but the vault is
  in a messy state.

For a single-user MCP this is rare. It matters when Obsidian is live-syncing at
the same moment you rename.

A later hardening would CAS “dest must not exist” on the dest put, and if dest
write succeeds but source delete conflicts, return an explicit “copied but not
unlinked” error instead of a generic internal failure.

## 3. MCP-written chunks use a different hash than Obsidian

Obsidian LiveSync names each piece of a file with a hash, like
`h:14ki8tx3ihyfx`. Desktop/iOS use **xxhash64** (WebAssembly). Cloudflare
Workers in this setup **cannot compile that WASM**, so MCP writes use
Commonlib’s pure-JS hasher (`mixed-purejs`).

Reading still works: the note document lists its children by id, and we fetch
those documents. Nobody re-hashes on read.

What you will see in practice:

- A note created in MCP appears in Obsidian after sync. Fine.
- If you then edit it **in Obsidian**, Obsidian re-chunks with xxhash64. New
  child ids, old MCP chunks become unused leftovers. Fine for correctness;
  slightly messy for storage until LiveSync GC.
- Dedup between “same paragraph written by MCP” and “same paragraph written by
  Obsidian” will not share a chunk. Irrelevant at personal-vault scale.

We chose this over “writes don’t work in workerd.” Matching xxhash64 would mean
a different hash implementation that does not use WASM.

## 4. After an MCP call, the object can stay awake for up to ~25 seconds

The old bug was: Commonlib starts a **live** `_changes` long-poll and never
stops, so the vault object never sleeps.

The fix: start Commonlib, immediately cancel its watcher, do the read/write,
`close()` when the last in-flight RPC finishes.

One leftover: the **in-flight** long-poll that Commonlib already sent is a
request sitting in `changesRoute`, waiting up to 25s (cap 55s) for a change or
timeout. Cancelling the client side does not abort that wait with an
`AbortSignal`. So after your MCP tool returns, the Durable Object may still be
“handling a request” until that timer fires.

That is **one** leftover wait, not a loop. It does not keep re-reading every
Obsidian push. Billing-wise it is a few seconds of duration per MCP burst, not
“forever.”

## 5. Durable Objects are not Workers Free

The vault **is** a Durable Object (SQLite). Cloudflare bills DO duration and
storage on the paid Workers plan. The Workers Free plan does not host this
architecture.

What *is* cheap: the object hibernates when nothing is in flight. iOS in the
background does not pin it. Mac LiveSync with Obsidian open does. MCP, after
the leftover wait above, should let it sleep.

So “Cloudflare free tier” as a product goal needs a caveat: you need the
DO-capable plan; you just want **idle cost** to be ~zero, which is the point of
closing Commonlib.

## 6. Two clients can still race on create (and on dest during move)

`create_file` is: look up the path; if missing, put a new note.

Two overlapping creates of `notes/a.md` can both see “missing” and both write.
Commonlib’s default put is “write the latest,” so the second can overwrite the
first instead of returning `conflict`. Same pattern as dest-in-move.

The edit path is better: it uses `expectedRevision` and
`putDBEntryWithLiveBaseRevision`, so a stale edit becomes `conflict`. Create
has no revision yet, so it needs a different rule: “put with no `_rev`; if the
doc exists, 409.”

## 7. OAuth: first login is scoped; refresh can keep write

On GitHub login we now grant only the scopes the client **asked for**. A
`vault:read`-only client does not get write at issue time.

Remaining point: when the OAuth library later **exchanges or refreshes** a
token, `tokenExchangeCallback` copies the **original grant** scopes into the
access token and ignores “this refresh only requested read.” So a client that
originally asked for read+write, then later asks for a read-only token, can
still have `vault:write` in `props.scopes`, and the tool check would allow
deletes.

Tool-time allowlist still applies (your GitHub login must remain on the list).
This is downscoping, not “revoked user still writes.”

## 8. A tweak change mid-call can use the old decoder

LiveSync stores “preferred tweaks” (compression, case-sensitive names) on a
local doc. We fingerprint that and rebuild Commonlib when it changes **and** no
RPC is using the old session.

If a tweak flips **while** an MCP call is in flight, we keep using the old
Commonlib until that call finishes. That avoids ripping the session out from
under the caller. The next call gets the new fingerprint.

The leftover: that in-flight call might decode with the old case-sensitivity or
compression. Rare (you don’t flip tweaks during a tool call), and safer than
crashing the in-flight read.

## What to do next

Cheap, worth doing before staging:

- `VAULT_DATABASE` / `MCP_PUBLIC_BASE_URL` 500s
- README title
- read-only write-tool test
- consent-page wording
- `requestedScope` in `tokenExchangeCallback`
- same-object Commonlib retry test

Real design leftovers for after it is useful:

- dest-must-not-exist CAS on create/move
- atomic-enough move
- list `startkey`
- maybe abort the leftover long-poll
