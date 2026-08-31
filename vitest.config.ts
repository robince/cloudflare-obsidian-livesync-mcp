import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      'octagonal-wheels/hash/xxhash.js': new URL('./src/livesync-vault/worker-xxhash.ts', import.meta.url).pathname,
    },
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: { bindings: { COUCHDB_PASSWORD: 'test-password' } },
    }),
  ],
});
