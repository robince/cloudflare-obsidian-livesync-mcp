import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stagingConfig } from '../scripts/staging/config.mjs';
const env = {
  STAGING_LIVESYNC_ROOT: '/tmp/pinned', STAGING_COUCH_URL: 'https://storage.example',
  STAGING_COUCH_USER: 'test', STAGING_COUCH_PASSWORD: 'test',
  STAGING_DATABASE: 'mcp-conflict-staging-01234567', STAGING_MCP_URL: 'https://mcp.example/mcp',
  STAGING_MCP_WRITE_TOKEN: 'test', STAGING_MCP_READ_TOKEN: 'test', STAGING_CONFIRM_DISPOSABLE: 'yes',
};
test('requires disposable database and explicit acknowledgement', () => {
  assert.equal(stagingConfig(env).database, env.STAGING_DATABASE);
  assert.throws(() => stagingConfig({ ...env, STAGING_DATABASE: 'personal-vault' }));
  assert.throws(() => stagingConfig({ ...env, STAGING_CONFIRM_DISPOSABLE: '' }));
});
test('rejects insecure credential transport and shared Obsidian profiles', () => {
  for (const url of ['http://remote.example', 'https://user:pass@example.com', 'https://example.com?token=x']) {
    assert.throws(() => stagingConfig({ ...env, STAGING_COUCH_URL: url }));
  }
  assert.throws(() => stagingConfig({ ...env, E2E_OBSIDIAN_USE_USER_DATA_DIR: 'false' }));
  assert.throws(() => stagingConfig({ ...env, E2E_OBSIDIAN_ARGS: '--user-data-dir=/normal' }));
});
