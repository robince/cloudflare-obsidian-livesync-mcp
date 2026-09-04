# Gate 0: reproducible workspace

## Baseline

Before the workspace conversion, the storage Worker passed its TypeScript check,
8 hermetic published-PouchDB integration tests, and 1 sibling-checkout PouchDB
compatibility test. Its Wrangler dry-run bundle measured 260.72 KiB (56.47 KiB
gzip).

## Reproducibility contract

- The root package remains the `cloudflare-pouchdb` storage Worker.
- The MCP Worker and shared contracts are npm workspaces under `apps/` and
  `packages/`, using the root lockfile.
- Production dependencies must resolve from the npm registry. Run
  `npm run check:dependencies` to enforce this in CI and locally.
- The upstream-PouchDB compatibility suite is deliberately separate from the
  hermetic release checks. Its GitHub Actions job checks out and builds PouchDB
  beside this repository before running `npm run test:upstream-pouchdb`.

## Verification

Run `npm ci`, then:

```sh
npm run types:check
npm run check
npm run test:all
npm run dry-run
```

The upstream compatibility suite runs nightly, on demand, and when its test or
dependency manifests change.

The Gate 0 verification run passed all 8 hermetic tests. The registry-backed
storage bundle measured 236.38 KiB (54.46 KiB gzip), and the MCP scaffold
measured 0.28 KiB (0.21 KiB gzip).
