import { defineConfig } from 'vitest/config';

// Tool and OAuth helper tests are pure Node tests. The deployed Worker is
// checked separately by Wrangler, so this avoids inventing a two-Worker test
// harness before the MWE needs one.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/vault-tools.test.ts'],
  },
});
