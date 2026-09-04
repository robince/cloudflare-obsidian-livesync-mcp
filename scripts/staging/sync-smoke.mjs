import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { startStagingSession, canDisposeStagingVault } from './session.mjs';
import { LIVESYNC_COMMIT } from './config.mjs';
const root = process.env.STAGING_LIVESYNC_ROOT;
assert(root, 'Set STAGING_LIVESYNC_ROOT');
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), LIVESYNC_COMMIT);
const load = name => import(pathToFileURL(join(root, 'test/e2e-obsidian/runner', `${name}.ts`)).href);
const { requireObsidianBinary, discoverObsidianCli } = await load('environment');
const { createTemporaryVault } = await load('vault');
const { evalObsidianJson } = await load('cli');
const workflow = await load('liveSyncWorkflow');
const directory = resolve(import.meta.dirname, '../../.wrangler/conflict-staging');
const state = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8'));
const mcp = JSON.parse(await readFile(join(directory, 'mcp.json'), 'utf8'));
const secrets = JSON.parse(await readFile(join(directory, 'storage-secrets.json'), 'utf8'));
const uri = new URL(mcp.vars.MCP_PUBLIC_BASE_URL);
assert(uri.hostname.startsWith(`${state.mcp}.`), 'Not the generated staging deployment');
uri.hostname = uri.hostname.replace(`${state.mcp}.`, `${state.storage}.`);
const settings = { uri: uri.origin, username: 'admin', password: secrets.COUCHDB_PASSWORD,
  dbName: `mcp-conflict-staging-${randomBytes(8).toString('hex')}` };
const output = await mkdtemp(join(tmpdir(), 'mcp-sync-smoke-'));
await writeFile(join(output, 'private-resources.json'), JSON.stringify({ database: settings.dbName, storage: state.storage }), { mode: 0o600 });
const vaults = [];
const active = new Set();
let phase = 'setup';
let passed = false;
const cli = discoverObsidianCli().binary;
const overrides = { liveSync: false, syncOnStart: false, syncOnSave: false, periodicReplication: false };
const start = async vault => {
  const session = await startStagingSession(root, { binary: requireObsidianBinary(), cliBinary: cli, vault,
    pluginData: workflow.createE2eCouchDbPluginData(settings, overrides),
    localStorageEntries: workflow.createE2eObsidianDeviceLocalState(vault.name), diagnosticsDir: output,
  });
  active.add(session);
  await workflow.waitForLiveSyncCoreReady(cli, session.cliEnv);
  await workflow.configureCouchDb(cli, session.cliEnv, settings, overrides);
  await workflow.prepareRemote(cli, session.cliEnv);
  return session;
};
const stop = async session => { await session.app.stop(); active.delete(session); };
const sync = session => workflow.pushLocalChanges(cli, session.cliEnv);
const path = 'staging-roundtrip.md';
const read = async (vault, expected) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await readFile(join(vault.path, path), 'utf8').catch(() => '') === expected) return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('File did not converge');
};
try {
  const a = await createTemporaryVault('mcp-sync-a-'); vaults.push(a);
  const b = await createTemporaryVault('mcp-sync-b-'); vaults.push(b);
  phase = 'A creates';
  let session = await start(a);
  await evalObsidianJson(cli, `(async()=>{await app.vault.create(${JSON.stringify(path)},'from A');return JSON.stringify({ok:true})})()`, session.cliEnv);
  await workflow.waitForLocalDatabaseEntry(cli, session.cliEnv, path);
  await sync(session); await stop(session);
  phase = 'B receives and edits';
  session = await start(b); await sync(session); await read(b, 'from A');
  await evalObsidianJson(cli, `(async()=>{await app.vault.modify(app.vault.getAbstractFileByPath(${JSON.stringify(path)}),'from B');return JSON.stringify({ok:true})})()`, session.cliEnv);
  await sync(session); await stop(session);
  phase = 'A receives';
  session = await start(a); await sync(session); await read(a, 'from B'); await stop(session);
  passed = true;
  console.log('Real Obsidian A → staging storage → B → staging storage → A replication passed. MCP authentication was not bypassed.');
} catch {
  console.error(`Remote client smoke failed during ${phase}; inspect private diagnostics locally.`);
  process.exitCode = 1;
} finally {
  let stopped = true;
  for (const session of active) { try { await session.app.stop(); } catch { stopped = false; } }
  if (stopped) for (const vault of vaults) {
    if (canDisposeStagingVault(vault)) await vault.dispose(); else stopped = false;
  }
  if (!stopped) process.exitCode = 1;
  await writeFile(join(output, 'report.json'), JSON.stringify({ passed, phase, clientsStopped: stopped }), { mode: 0o600 });
  console.log(`Private smoke evidence and disposable database cleanup reference: ${output}`);
}
