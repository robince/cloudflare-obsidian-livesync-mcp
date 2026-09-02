# Residual issues

This note records the deliberately deferred limitations after the guarded-write
checkpoint. It targets Self-hosted LiveSync 1.0.21 and Commonlib 0.1.19 only.

## Deep listing pages still rescan earlier documents

Listing stops after it collects one response page, so response size and memory
are bounded. A deep cursor page still starts Commonlib's metadata traversal at
the beginning and skips earlier document IDs. If large-vault staging shows this
is material, the next optimization is a Commonlib enumeration start key.

## Worker WASM support and the xxhash compatibility shim

Workers support imported, precompiled WebAssembly modules. They do not permit
compiling or instantiating raw WASM bytes at runtime.

Commonlib 0.1.19 imports Octagonal Wheels' browser-oriented xxhash loader. That
loader embeds WASM in a `Uint8Array` and calls `WebAssembly.instantiate(bytes)`,
which workerd rejects. The installed `xxhash-wasm` package also provides a
`workerd` export that imports `xxhash.wasm` as a compiled module and produces
the same xxhash32/xxhash64 results.

The storage Worker aliases only Octagonal Wheels' xxhash entrypoint to a small
compatibility module backed by that Worker export. Commonlib still selects
`xxhash64` and continues to own LiveSync hashing, splitting, and serialization.
The alias should be removed when Octagonal Wheels or Commonlib ships an
equivalent Worker-aware loader.

## Create CAS requires a pinned Commonlib compatibility patch

The normal LiveSync plugin create flow begins with a host vault adapter and a
filesystem event. A Worker has no vault filesystem, so it correctly uses
`DirectFileManipulator` to write the LiveSync database directly.

Commonlib's published `putDBEntryWithLiveBaseRevision` always adds `_rev` and
therefore only supports updates. Its default `putDBEntry` rereads and then uses
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

The committed OAuth KV preview ID is a local placeholder. Staging and
production must supply real namespace identifiers, OAuth application values,
allowlists, domains, and secrets out of band. No fabricated or environment-
specific identifier should be committed merely to make a static review quiet.
