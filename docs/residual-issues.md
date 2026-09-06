# Residual issues

This note records remaining limitations and dependency workarounds for the
implemented sync and MCP servers. Compatibility evidence uses Self-hosted
LiveSync 1.0.21 and Commonlib 0.1.19.

The Worker WASM initialization issue is resolved by the existing xxHash shim;
see [Worker hashing compatibility](development.md#worker-hashing-compatibility).

## Deep listing pages still rescan earlier documents

Listing stops after it collects one response page, so response size and memory
are bounded. A deep cursor page still starts Commonlib's metadata traversal at
the beginning and skips earlier document IDs. If large-vault staging shows this
is material, the next optimization is a Commonlib enumeration start key.

Conflict-aware listings add at most 100 metadata lookups per response. A page
may be short or empty with a continuation cursor when many logical deletions
are scanned; callers must follow the cursor. No branch bodies are hydrated.

## Conflict reconciliation is bounded, not a tree-wide transaction

`revision_conflict` means a rejected stale CAS: reread and reassess.
`livesync_conflict` means unresolved LiveSync branches requiring Obsidian review.
`conflict_reconciled` means safe pairwise progress, never successful execution
of the triggering mutation. A read-only caller cannot cause that progress.

Commonlib supplies merge content and pair ordering; MCP retains revision CAS
without a request-wide Durable Object lock. Another replica may introduce or
extend a leaf between checks. If the winning write succeeds but losing-leaf
removal fails, both remain recoverable and MCP reports reconciliation progress.
An interrupted request can likewise leave a partially reconciled tree, which
the next operation inspects afresh. The deterministic database winner is not
proof of the file currently displayed on any Obsidian device.

The automatic budget is eight pairs, sixteen live leaves, and 512,000 bytes /
1,024 chunks per required body. Over-limit, missing-history, missing-chunk,
delete-versus-modify, and differing binary cases are left to Obsidian. No newer-
mtime binary policy, background resolver, or attachment storage
change is implemented. The [real-client conflict staging matrix](conflict-staging-results.md)
passed, including concurrent creates, overlapping edits, and binary conflicts.
Those results cover the documented cases and versions.

## Create CAS requires a pinned Commonlib compatibility patch

The normal LiveSync plugin create flow begins with a host vault adapter and a
filesystem event. A Worker has no vault filesystem, so it correctly uses
`DirectFileManipulator` to write the LiveSync database directly.

In the pinned Commonlib release, `putDBEntryWithLiveBaseRevision` adds
`_rev: undefined` when no base revision is supplied, which PouchDB rejects. Its default `putDBEntry` rereads and then uses
a forced put, which can overwrite a concurrent create. The install-time,
version-checked patch makes the revision-aware function omit `_rev` only when
the caller supplies no base revision. Commonlib still writes chunks and builds
the metadata document; the final ordinary PouchDB put supplies atomic
create-only conflict behaviour.

The patch intentionally fails installation if Commonlib is no longer exactly
0.1.19 or its relevant source changes. This should become an upstream
`putDBEntryIfAbsent` API and the local patch should then be removed.

## Losing creates can leave unreferenced chunks

Commonlib writes content-addressed chunks before publishing the metadata
document. If two creates race, the losing metadata put returns conflict after
its chunks may already have been stored. The visible winner remains readable
and no conflict branch is created. Inline cleanup would risk deleting chunks
another note references, so garbage collection remains LiveSync maintenance,
not part of an MCP write.

## Profile changes during one call take effect on the next call

Each RPC inspects one profile, creates a Commonlib facade from those exact
settings, and closes that same facade in `finally`. If compression or
filename-case settings change during an operation, that operation finishes
with its acquired profile; the next RPC inspects and uses the new profile.
Replacing a decoder underneath an active operation would be less safe.

## Deployment identifiers remain out of the repository

The committed OAuth KV configuration contains only the `OAUTH_KV` binding;
there is no placeholder namespace or preview ID. Wrangler provisions the
namespace on first deployment. Keep its assigned ID and other account-specific
settings in the ignored deployment configuration, and credentials in Worker
secrets. See [MCP deployment](../DEPLOY.md#deploy-the-mcp-worker).

## Contract 5 follow-up boundaries

Search now includes a disposable FTS/property index and stateless continuation.
Cleanup protects all retained readable revisions and fails closed within its
budget. Maintenance still requires completed replication and paused writers;
a disconnected client may hold references the server has never received.
Outline parsing has explicit complexity limits in addition to the unchanged
note-size limit. Obsidian attachment placement, relative links, case handling
and move effects still require a settings review.
