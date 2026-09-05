// Real plug-in recovery in generated vaults and isolated Obsidian profiles only.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { startStagingSession, canDisposeStagingVault } from './session.mjs';
import { LIVESYNC_COMMIT } from './config.mjs';
const root = process.env.STAGING_LIVESYNC_ROOT;
assert(root, 'Set STAGING_LIVESYNC_ROOT to the built, pinned LiveSync checkout');
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), LIVESYNC_COMMIT);
const load = name => import(pathToFileURL(join(root, 'test/e2e-obsidian/runner', `${name}.ts`)).href);
const { requireObsidianBinary, discoverObsidianCli } = await load('environment');
const { createTemporaryVault } = await load('vault');
const { evalObsidianJson } = await load('cli');
const workflow = await load('liveSyncWorkflow');
const { obsidianRemoteDebuggingPort, withObsidianPage } = await load('ui');
const directory = resolve('.wrangler/backup-staging');
const config = JSON.parse(await readFile(join(directory, 'storage.json'), 'utf8'));
const secrets = JSON.parse(await readFile(join(directory, 'secrets.json'), 'utf8'));
const smoke = JSON.parse(await readFile(join(directory, 'smoke.json'), 'utf8'));
assert(new URL(smoke.url).hostname.startsWith(`${config.name}.`) && config.name.startsWith('livesync-backup-staging-'));
const fixture = JSON.parse(await readFile('test/fixtures/livesync-1.0.21.json', 'utf8'));
const settings = { uri: smoke.url, username: 'admin', password: secrets.COUCHDB_PASSWORD, dbName: smoke.database };
const target = `${smoke.database}-clients-${Date.now()}`;
const response = await fetch(`${smoke.url}/_backup/restore?database=${smoke.database}`, { method: 'POST', headers: {
  authorization: `Basic ${Buffer.from(`admin:${secrets.COUCHDB_PASSWORD}`).toString('base64')}`, 'content-type': 'application/json',
}, body: JSON.stringify({ target, id: smoke.id }) });
assert(response.ok, `Restore failed (${response.status})`);
const output = await mkdtemp(join(tmpdir(), 'livesync-backup-clients-'));
const vaults = [], active = new Set();
const cli = discoverObsidianCli().binary;
const overrides = { ...fixture.localDocuments['_local/obsydian_livesync_milestone'].tweak_values.PREFERRED,
  liveSync: false, syncOnStart: false, syncOnSave: false, periodicReplication: false, doNotSuspendOnFetching: false };
const start = async (vault, initial = false) => {
  const session = await startStagingSession(root, { binary: requireObsidianBinary(), cliBinary: cli, vault,
    ...(initial ? { pluginData: workflow.createE2eCouchDbPluginData(settings, overrides), localStorageEntries: workflow.createE2eObsidianDeviceLocalState(vault.name) } : {}), diagnosticsDir: output });
  active.add(session);
  if (!(await access(join(vault.path, 'flag_fetch.md')).then(() => true, () => false))) {
    await workflow.waitForLiveSyncCoreReady(cli, session.cliEnv);
    const review = await evalObsidianJson(cli, "(()=>{return JSON.stringify({pending:app.plugins.plugins['obsidian-livesync'].core.services.setting.currentSettings().versionUpFlash.includes('compatibility review')})})()", session.cliEnv);
    if (review.pending) await workflow.resumeCompatibilityReview(obsidianRemoteDebuggingPort());
  }
  return session;
};
const stop = async session => { await session.app.stop(); active.delete(session); };
const wait = async condition => { const deadline = Date.now() + 120000; while (!(await condition())) { if (Date.now() > deadline) throw new Error('Timed out waiting for client recovery'); await new Promise(r => setTimeout(r, 500)); } };
let phase = 'seed clients', passed = false;
try {
  for (let i = 0; i < 2; i++) {
    const vault = await createTemporaryVault(`backup-client-${i}-`); vaults.push(vault);
    const session = await start(vault, true);
    await workflow.waitForLiveSyncCoreReady(cli, session.cliEnv);
    await workflow.configureCouchDb(cli, session.cliEnv, settings, overrides);
    await workflow.prepareRemote(cli, session.cliEnv);
    await workflow.pushLocalChanges(cli, session.cliEnv);
    await wait(async () => (await readFile(join(vault.path, 'notes/frontmatter.md'), 'utf8').catch(() => '')) === fixture.files['notes/frontmatter.md']);
    await evalObsidianJson(cli, `(async()=>{await app.vault.modify(app.vault.getAbstractFileByPath('notes/frontmatter.md'),'unsynchronised local edit');await app.vault.create('local-only.md','local-only');await app.vault.delete(app.vault.getAbstractFileByPath('notes/crlf.md'));return JSON.stringify({ok:true})})()`, session.cliEnv);
    await workflow.waitForLocalDatabaseEntry(cli, session.cliEnv, 'local-only.md');
    // This old interrupted-fetch position must not be reused for the fresh remote URL.
    await evalObsidianJson(cli, `(()=>{const s=app.plugins.plugins['obsidian-livesync'].core.services.setting;s.setSmallConfig('fast-fetch-checkpoint',JSON.stringify({remote:${JSON.stringify(`${settings.uri}/${settings.dbName}`)},sequence:'999999999'}));s.setSmallConfig('simple-fetch-mode',JSON.stringify({stage1:'Overwrite all with remote files',stage2:'Delete local files if not on remote'}));return JSON.stringify({ok:true})})()`, session.cliEnv);
    await workflow.configureCouchDb(cli, session.cliEnv, { ...settings, dbName: target }, overrides);
    if (i === 0) {
      // Interrupt the real plugin's stream after valid rows. Its own failure path must
      // persist the contiguous checkpoint and remain suspended until the flag retry.
      await withObsidianPage(obsidianRemoteDebuggingPort(), async page => {
        const pattern = `**/${target}/_changes*`;
        let interrupted = false;
        await page.route(pattern, async route => {
          const requestUrl = new URL(route.request().url());
          if (requestUrl.searchParams.get('include_docs') !== 'true') return route.continue();
          const upstream = await route.fetch();
          const lines = (await upstream.text()).split('\n');
          assert(lines.length > 5, 'Expected a streaming changes response');
          interrupted = true;
          await route.fulfill({ response: upstream, body: lines.slice(0, 5).join('\n') + '\ninvalid-stream-record\n' });
        });
        try {
          const result = await evalObsidianJson(cli, `(async()=>{const core=app.plugins.plugins['obsidian-livesync'].core;let failed=false;try{await core.serviceModules.rebuilder.$fetchLocalDBFast(false)}catch{failed=true}return JSON.stringify({failed,checkpoint:core.services.setting.getSmallConfig('fast-fetch-checkpoint'),suspended:core.services.setting.currentSettings().suspendFileWatching})})()`, session.cliEnv);
          assert(interrupted && result.failed && result.suspended);
          assert(Number(JSON.parse(result.checkpoint).sequence) > 0);
        } finally { await page.unroute(pattern); }
      });
    }
    await stop(session);
    await writeFile(join(vault.path, 'flag_fetch.md'), '');
  }
  phase = 'remote-wins reset';
  for (const vault of vaults) {
    const session = await start(vault);
    await wait(async () => !(await access(join(vault.path, 'flag_fetch.md')).then(() => true, () => false)));
    await workflow.waitForLiveSyncCoreReady(cli, session.cliEnv);
    assert.equal(await readFile(join(vault.path, 'notes/frontmatter.md'), 'utf8'), fixture.files['notes/frontmatter.md']);
    assert.equal(await readFile(join(vault.path, 'notes/crlf.md'), 'utf8'), fixture.files['notes/crlf.md']);
    assert.equal(await access(join(vault.path, 'local-only.md')).then(() => true, () => false), false);
    await workflow.pushLocalChanges(cli, session.cliEnv);
    await stop(session);
  }
  phase = 'bidirectional sync after reset';
  let session = await start(vaults[0]); await workflow.waitForLiveSyncCoreReady(cli, session.cliEnv);
  await evalObsidianJson(cli, `(async()=>{await app.vault.create('roundtrip.md','from A');return JSON.stringify({ok:true})})()`, session.cliEnv);
  await workflow.waitForLocalDatabaseEntry(cli, session.cliEnv, 'roundtrip.md');
  await workflow.pushLocalChanges(cli, session.cliEnv); await stop(session);
  session = await start(vaults[1]); await workflow.waitForLiveSyncCoreReady(cli, session.cliEnv);
  await workflow.pushLocalChanges(cli, session.cliEnv);
  await wait(async () => (await readFile(join(vaults[1].path, 'roundtrip.md'), 'utf8').catch(() => '')) === 'from A');
  await evalObsidianJson(cli, `(async()=>{await app.vault.modify(app.vault.getAbstractFileByPath('roundtrip.md'),'from B');return JSON.stringify({ok:true})})()`, session.cliEnv);
  await workflow.pushLocalChanges(cli, session.cliEnv); await stop(session);
  session = await start(vaults[0]); await workflow.waitForLiveSyncCoreReady(cli, session.cliEnv);
  await workflow.pushLocalChanges(cli, session.cliEnv);
  await wait(async () => (await readFile(join(vaults[0].path, 'roundtrip.md'), 'utf8').catch(() => '')) === 'from B');
  await stop(session); passed = true;
} catch (error) { console.error(`Client recovery failed during ${phase}: ${error.message}`); process.exitCode = 1; }
finally {
  for (const session of active) await stop(session).catch(() => {});
  await writeFile(join(output, 'report.json'), JSON.stringify({ passed, phase, target, clientsStopped: active.size === 0 }), { mode: 0o600 });
  if (passed && !active.size) for (const vault of vaults) if (canDisposeStagingVault(vault)) await vault.dispose();
  console.log(JSON.stringify({ passed, phase, output }));
}
