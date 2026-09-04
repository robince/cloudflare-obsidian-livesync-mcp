import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { readFileSync, readdirSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const storageBundle = new URL('../../dist/test-storage/', import.meta.url).pathname;
const storageWasm = readdirSync(storageBundle).find((file) => file.endsWith('.wasm'));
if (!storageWasm) throw new Error('The storage Worker test bundle has no WASM module.');

export default defineConfig({
  test: {
    include: ['test/oauth-worker.test.ts'],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.oauth-test.jsonc' },
      miniflare: {
        bindings: {
          GITHUB_CLIENT_ID: 'github-client-test',
          GITHUB_CLIENT_SECRET: 'github-secret-test',
        },
        workers: [{
          name: 'cloudflare-pouchdb',
          modules: [
            { type: 'ESModule', path: 'index.js', contents: readFileSync(`${storageBundle}index.js`, 'utf8') },
            { type: 'CompiledWasm', path: storageWasm, contents: readFileSync(`${storageBundle}${storageWasm}`) },
          ],
          compatibilityDate: '2026-08-26',
          compatibilityFlags: ['nodejs_compat'],
          bindings: {
            COUCHDB_USERNAME: 'admin',
            COUCHDB_PASSWORD: 'test-password',
            CORS_ORIGINS: 'http://localhost',
          },
          durableObjects: {
            POUCH_DATABASES: { className: 'PouchDatabase', useSQLite: true },
          },
        }],
      },
    }),
  ],
});
