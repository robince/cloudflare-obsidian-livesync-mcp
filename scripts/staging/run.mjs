import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
const directory = resolve(import.meta.dirname, '../../.wrangler/conflict-staging');
const state = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8'));
const mcp = JSON.parse(await readFile(join(directory, 'mcp.json'), 'utf8'));
const secrets = JSON.parse(await readFile(join(directory, 'storage-secrets.json'), 'utf8'));
const mode = process.argv[2] ?? '--check';
const tokens = await readFile(join(directory, 'tokens.json'), 'utf8').then(JSON.parse).catch(error => {
  if (error.code === 'ENOENT' && mode === '--check') return { read: 'not-checked', write: 'not-checked' };
  if (error.code === 'ENOENT') {
    throw new Error('Staging OAuth tokens are required. Run the staging authorization helper.', { cause: error });
  }
  throw error;
});
const root = process.env.STAGING_LIVESYNC_ROOT;
if (!root) throw new Error('Set STAGING_LIVESYNC_ROOT to the built, pinned worktree.');
const origin = new URL(mcp.vars.MCP_PUBLIC_BASE_URL);
if (!origin.hostname.startsWith(`${state.mcp}.`)) throw new Error('Staging MCP origin does not match its generated worker name.');
const storageOrigin = new URL(origin);
storageOrigin.hostname = origin.hostname.replace(`${state.mcp}.`, `${state.storage}.`);
const child = spawn(process.execPath, ['--import', join(root, 'node_modules/tsx/dist/loader.mjs'),
  join(import.meta.dirname, 'conflicts.mjs'), mode], {
  stdio: 'inherit',
  env: { ...process.env,
    STAGING_COUCH_URL: storageOrigin.origin, STAGING_COUCH_USER: 'admin',
    STAGING_COUCH_PASSWORD: secrets.COUCHDB_PASSWORD, STAGING_DATABASE: state.database,
    STAGING_MCP_URL: `${origin.origin}/mcp`, STAGING_MCP_READ_TOKEN: tokens.read,
    STAGING_MCP_WRITE_TOKEN: tokens.write ?? tokens.read,
    STAGING_CONFIRM_DISPOSABLE: 'yes',
  },
});
child.on('error', error => {
  console.error(`Failed to start the staging conflict runner: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', code => { process.exitCode = code ?? 1; });
