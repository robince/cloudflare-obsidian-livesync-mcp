// Generates private, ignored deployment artefacts; does not deploy or alter a vault.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { stagingWorkerOrigin } from './config.mjs';
const root = resolve(import.meta.dirname, '../..');
const directory = join(root, '.wrangler/conflict-staging');
await mkdir(directory, { recursive: true, mode: 0o700 });
const statePath = join(directory, 'runtime.json');
if (process.argv[2] === '--origin') {
  const configPath = join(directory, 'mcp.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.vars.MCP_PUBLIC_BASE_URL = stagingWorkerOrigin(process.argv[3], config.name, process.argv[4]);
  await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
} else {
  const suffix = randomBytes(6).toString('hex');
  const state = { storage: `livesync-conflict-storage-${suffix}`, mcp: `livesync-conflict-mcp-${suffix}`,
    database: `mcp-conflict-staging-${suffix}` };
  // Exclusive creation prevents accidentally replacing the configuration of an active run.
  await writeFile(statePath, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 });
  const storage = JSON.parse(await readFile(join(root, 'wrangler.jsonc'), 'utf8'));
  storage.name = state.storage;
  storage.main = join(root, 'src/index.ts');
  storage.alias['octagonal-wheels/hash/xxhash.js'] = join(root, 'src/livesync-vault/worker-xxhash.ts');
  storage.observability = { enabled: false };
  const mcp = JSON.parse(await readFile(join(root, 'apps/cloudflare-obsidian-mcp/wrangler.jsonc'), 'utf8'));
  mcp.name = state.mcp;
  mcp.main = join(root, 'apps/cloudflare-obsidian-mcp/src/index.ts');
  mcp.durable_objects.bindings[0].script_name = state.storage;
  mcp.kv_namespaces = [{ binding: 'OAUTH_KV' }];
  mcp.vars.VAULT_DATABASE = state.database;
  mcp.vars.GITHUB_CLIENT_ID = '';
  mcp.vars.GITHUB_ALLOWED_USER_IDS = '';
  mcp.vars.MCP_WRITES_ENABLED = 'false';
  mcp.observability = { enabled: false };
  for (const [name, config] of [['storage', storage], ['mcp', mcp]]) {
    delete config.$schema;
    await writeFile(join(directory, `${name}.json`), JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
  }
  await writeFile(join(directory, 'storage-secrets.json'), JSON.stringify({ COUCHDB_PASSWORD: randomBytes(32).toString('base64url') }), { flag: 'wx', mode: 0o600 });
}
console.log('Ignored staging configuration prepared. No production configuration changed and no credentials printed.');
