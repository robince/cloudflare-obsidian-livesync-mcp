/** Real desktop acceptance runner. Invoke with the pinned checkout's tsx loader. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { LIVESYNC_COMMIT, stagingConfig } from './config.mjs';
import { startStagingSession, canDisposeStagingVault } from './session.mjs';

const mode = process.argv[2] ?? '--check';
assert(['--check', '--run', '--verify-readonly'].includes(mode), 'Expected --check, --run, or --verify-readonly');
let phase = 'configuration';
let operation = 'configure';
const evidence = { target: LIVESYNC_COMMIT, cases: [], acceptance: 'not_run' };
const active = new Set();
const clients = [];
const vaults = [];
let output;
try {
  const config = stagingConfig(process.env);
  const root = resolve(config.root);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), LIVESYNC_COMMIT,
    'Use an isolated worktree at the pinned LiveSync commit.');
  execFileSync('git', ['diff', '--quiet', 'HEAD', '--', 'src', 'test', 'package.json', 'package-lock.json'], { cwd: root });
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, '1.0.21');
  await readFile(join(root, 'main.js'));
  await readFile(join(root, 'styles.css'));
  const module = name => import(pathToFileURL(join(root, 'test/e2e-obsidian/runner', `${name}.ts`)).href);
  const environment = await module('environment');
  const binary = environment.requireObsidianBinary();
  const cliBinary = environment.discoverObsidianCli().binary;
  assert(cliBinary, 'Obsidian CLI is required');
  if (mode === '--check') {
    console.log('Staging configuration, pinned source, built artefacts, and real Obsidian executables are available. No clients launched or remote writes performed.');
  } else {
    output = await mkdtemp(join(tmpdir(), 'mcp-conflict-evidence-'));
    process.env.E2E_OBSIDIAN_DIAGNOSTICS_DIR = output;
    process.env.E2E_OBSIDIAN_CLI_TIMEOUT_MS = '30000';
    const connect = async token => {
      const client = new Client({ name: 'disposable-conflict-staging', version: '1' });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(config.mcp), {
        requestInit: { headers: { authorization: `Bearer ${token}` }, redirect: 'error' },
      }));
      return client;
    };
    const reader = await connect(config.readToken);
    const writer = await connect(config.writeToken);
    const call = (client, name, args = {}) => client.callTool({ name, arguments: args });
    const data = async (name, args) => {
      const result = await call(writer, name, args);
      assert(!result.isError, `Unexpected MCP error during ${phase}`);
      return result.structuredContent;
    };
    const raw = async (suffix = '', init = {}) => {
      const response = await fetch(`${config.couch}/${config.database}${suffix}`, {
        ...init, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`,
          'content-type': 'application/json' },
      });
      return response;
    };
    const tree = async path => {
      const response = await raw(`/${encodeURIComponent(path.toLowerCase())}?conflicts=true&revs_info=true`);
      assert.equal(response.status, 200, 'Missing staging document');
      const winner = await response.json();
      const revs = [winner._rev, ...(winner._conflicts ?? [])].sort();
      const leaves = [];
      for (const rev of revs) {
        const leaf = await raw(`/${encodeURIComponent(path.toLowerCase())}?rev=${encodeURIComponent(rev)}&revs=true`);
        assert.equal(leaf.status, 200);
        leaves.push(await leaf.json());
      }
      return { winner: winner._rev, leaves };
    };
    if (mode === '--verify-readonly') {
      phase = 'write kill switch';
      for (const client of [reader, writer]) {
        const tools = (await client.listTools()).tools.map(t => t.name);
        assert(!tools.includes('create_file'), 'Write tools still advertised');
        const denied = await call(client, 'create_file', { path: 'staging-disabled.md', content: 'NEVER' }).catch(() => ({ isError: true }));
        assert.equal(denied.isError, true);
      }
      const status = await call(reader, 'vault_status');
      if (status.isError) {
        // The initial preflight runs before the matrix creates its fresh database.
        // Do not accept other read failures, or mask a failure for an existing DB.
        assert.equal(status.structuredContent?.error?.code, 'not_found');
        assert.equal((await raw()).status, 404);
      } else {
        const before = await tree('staging-safe.md');
        for (const client of [reader, writer]) {
          const read = await call(client, 'read_file', { path: 'staging-safe.md' });
          assert(!read.isError, 'Reads stopped working after the write kill switch');
          assert.equal(typeof read.structuredContent?.content, 'string');
        }
        assert.deepEqual(await tree('staging-safe.md'), before);
      }
      evidence.cases.push({ case: 'write_switch_off', passed: true });
      evidence.acceptance = 'write_switch_verified_only';
    } else {
      phase = 'empty remote guard';
      assert.equal((await raw()).status, 404, 'Refusing an existing database, even if empty. Use a new staging name.');
      assert.equal((await raw('', { method: 'PUT' })).status, 201);
      const { createTemporaryVault } = await module('vault');
      const workflow = await module('liveSyncWorkflow');
      const { evalObsidianJson } = await module('cli');
      const { withObsidianPage } = await module('ui');
      const settings = { uri: config.couch, username: config.username, password: config.password, dbName: config.database };
      const overrides = {
        liveSync: false, syncOnStart: false, syncOnSave: false, syncOnEditorSave: false,
        syncOnFileOpen: false, periodicReplication: false, syncAfterMerge: false,
        disableMarkdownAutoMerge: true, checkConflictOnlyOnOpen: true,
        showMergeDialogOnlyOnActive: true, resolveConflictsByNewerFile: false,
      };
      const a = await createTemporaryVault('mcp-conflict-a-'); vaults.push(a);
      const b = await createTemporaryVault('mcp-conflict-b-'); vaults.push(b);
      const start = async vault => {
        operation = 'start client';
        const session = await startStagingSession(root, {
          binary, cliBinary, vault, artifactRoot: root, diagnosticsDir: output,
          pluginData: workflow.createE2eCouchDbPluginData(settings, overrides),
          localStorageEntries: workflow.createE2eObsidianDeviceLocalState(vault.name),
        });
        active.add(session);
        await workflow.waitForLiveSyncCoreReady(cliBinary, session.cliEnv);
        await workflow.configureCouchDb(cliBinary, session.cliEnv, settings, overrides);
        await workflow.prepareRemote(cliBinary, session.cliEnv);
        return session;
      };
      const stop = async session => { operation = 'stop client'; await session.app.stop(); active.delete(session); };
      const sync = async session => { operation = 'replicate'; await workflow.pushLocalChanges(cliBinary, session.cliEnv); };
      const evaluate = (session, source) => evalObsidianJson(cliBinary, `(async()=>{const core=app.plugins.plugins['obsidian-livesync'].core;${source}})()`, session.cliEnv);
      const edit = async (session, path, content) => {
        operation = 'edit local file';
        await evaluate(session, `const path=${JSON.stringify(path)}, content=${JSON.stringify(content)};
          const file=app.vault.getAbstractFileByPath(path);
          if(content===null){if(file) await app.vault.delete(file);}
          else if(file) await app.vault.modify(file,content); else await app.vault.create(path,content);
          await core.services.fileProcessing.commitPendingFileEvents();
          const deadline=Date.now()+30000;
          while(Date.now()<deadline){
            const entry=await core.localDatabase.getDBEntry(path,undefined,false,true,true);
            const value=entry&&Array.isArray(entry.data)?entry.data.join(''):entry&&entry.data;
            if(content===null ? entry&&entry.deleted : entry&&!entry.deleted&&value===content) return JSON.stringify({ok:true});
            await new Promise(r=>setTimeout(r,100));
          }
          throw new Error('Local file event did not reach LiveSync');`);
      };
      const waitContent = async (vault, path, expected) => {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          const content = await readFile(join(vault.path, path), 'utf8').catch(() => null);
          if (content === expected) return;
          await new Promise(r => setTimeout(r, 250));
        }
        throw new Error('Vault content did not converge');
      };
      phase = 'initialisation';
      let session = await start(a);
      await evaluate(session, `await core.services.replicator.getActiveReplicator()
        .setPreferredRemoteTweakSettings(core.services.setting.currentSettings());
        return JSON.stringify({ok:true});`);
      await stop(session);
      const initialStatus = await data('vault_status');
      assert.equal(initialStatus.contractVersion, 3);
      assert.equal(initialStatus.compatible, true, 'Plugin did not establish a supported profile');
      // Establish that MCP really targets this fresh database before any conflict.
      phase = 'MCP binding identity';
      const probe = `staging-probe-${crypto.randomUUID()}`;
      assert.equal((await raw('/h:staging-probe', { method: 'PUT', body: JSON.stringify({ type: 'leaf', data: probe }) })).status, 201);
      assert.equal((await raw('/staging-probe.md', { method: 'PUT', body: JSON.stringify({
        path: 'staging-probe.md', type: 'plain', datatype: 'plain', children: ['h:staging-probe'],
        eden: {}, size: probe.length, ctime: 1, mtime: 1,
      }) })).status, 201);
      assert.equal((await data('read_file', { path: 'staging-probe.md' })).content, probe,
        'MCP is not bound to the disposable database. No MCP mutations attempted.');
      const marker = await data('create_file', { path: 'staging-marker.md', content: 'disposable staging marker' });
      assert.equal((await tree(marker.path)).winner, marker.revision);
      phase = 'normal MCP propagation';
      for (const vault of [a, b]) {
        session = await start(vault); await sync(session);
        await waitContent(vault, marker.path, 'disposable staging marker'); await stop(session);
      }
      const updated = await data('edit_file', { path: marker.path, expectedRevision: marker.revision, content: 'edited' });
      const appended = await data('append_file', { path: marker.path, expectedRevision: updated.revision, content: '\nderived' });
      for (const vault of [a, b]) {
        session = await start(vault); await sync(session); await waitContent(vault, marker.path, 'edited\nderived'); await stop(session);
      }
      const stale = await call(writer, 'delete_file', { path: marker.path, expectedRevision: marker.revision });
      assert.equal(stale.structuredContent?.error?.code, 'revision_conflict');
      await data('delete_file', { path: marker.path, expectedRevision: appended.revision });
      for (const vault of [a, b]) {
        session = await start(vault); await sync(session); await waitContent(vault, marker.path, null); await stop(session);
      }
      evidence.cases.push({ case: 'normal_and_stale', passed: true });
      const cases = [
        { name: 'safe', base: 'start\nbase\nend\n', left: 'A\nbase\nend\n', right: 'start\nbase\nB\n', merged: 'A\nbase\nB\n' },
        { name: 'identical', base: 'base\n', left: 'same\n', right: 'same\n', merged: 'same\n' },
        { name: 'overlap', base: 'base\n', left: 'left\n', right: 'right\n' },
        { name: 'delete_edit', base: 'base\n', left: null, right: 'modified\n' },
        { name: 'independent', left: 'created A\n', right: 'created B\n' },
        { name: 'three', base: 'start\nbase\nend\n', left: 'A\nbase\nend\n', right: 'X\nbase\nB\n', third: 'start\nbase\nB\n' },
      ];
      for (const scenario of cases) {
        phase = scenario.name;
        console.log(`Starting disposable case: ${scenario.name}`);
        const path = `staging-${scenario.name}.md`;
        if (scenario.base !== undefined) await data('create_file', { path, content: scenario.base });
        for (const vault of [a, b]) {
          session = await start(vault); await sync(session);
          if (scenario.base !== undefined) await waitContent(vault, path, scenario.base);
          await stop(session);
          await cp(vault.path, join(output, `${scenario.name}-${vault === a ? 'a' : 'b'}-backup`), { recursive: true, errorOnExist: true });
          if (scenario.third && vault === a) await cp(vault.statePath, join(output, 'three-a-state-backup'), { recursive: true, errorOnExist: true });
        }
        // Genuine file API edits in independent clients: no raw forced revisions.
        for (const [vault, content] of [[a, scenario.left], [b, scenario.right]]) {
          session = await start(vault); await edit(session, path, content); await sync(session); await stop(session);
        }
        if (scenario.third) {
          // Restore only our stopped, generated A profile to its offline base.
          // This models a stale device backup, not a hand-authored revision tree.
          assert.equal(active.size, 0);
          await rename(a.path, join(output, 'three-a-after-first'));
          await rename(a.statePath, join(output, 'three-a-state-after-first'));
          await cp(join(output, 'three-a-backup'), a.path, { recursive: true });
          await cp(join(output, 'three-a-state-backup'), a.statePath, { recursive: true });
          session = await start(a);
          await edit(session, path, 'temporary offline edit\n');
          await edit(session, path, scenario.third);
          await sync(session); await stop(session);
        }
        const before = await tree(path);
        assert.equal(before.leaves.length, scenario.third ? 3 : 2, 'Clients did not produce independent live branches');
        const read = await call(reader, 'read_file', { path });
        assert.equal(read.structuredContent?.error?.code, 'livesync_conflict');
        const denied = await call(reader, 'append_file', { path, expectedRevision: before.winner, content: 'NEVER' });
        assert.equal(denied.isError, true);
        assert.deepEqual(await tree(path), before);
        const result = await call(writer, 'append_file', { path, expectedRevision: before.winner, content: 'NEVER' });
        let expected;
        if (scenario.merged !== undefined) {
          assert.equal(result.structuredContent?.error?.code, 'conflict_reconciled');
          const fresh = await data('read_file', { path });
          assert.equal(fresh.content, scenario.merged);
          expected = scenario.merged + 'deliberate retry\n';
          await data('append_file', { path, expectedRevision: fresh.revision, content: 'deliberate retry\n' });
        } else {
          if (scenario.third) {
            assert.equal(result.structuredContent?.error?.code, 'conflict_reconciled');
            const partial = await tree(path);
            assert.equal(partial.leaves.length, 2);
            const manual = await call(writer, 'append_file', { path, expectedRevision: partial.winner, content: 'NEVER' });
            assert.equal(manual.structuredContent?.error?.code, 'livesync_conflict');
            assert.deepEqual(await tree(path), partial);
          } else {
            assert.equal(result.structuredContent?.error?.code, 'livesync_conflict');
            assert.deepEqual(await tree(path), before);
          }
          session = await start(b); await sync(session);
          await evaluate(session, `const path=${JSON.stringify(path)};
            const file=app.vault.getAbstractFileByPath(path);if(file) await app.workspace.getLeaf(false).openFile(file);
            await core.services.conflict.queueCheckFor(path);return JSON.stringify({ok:true});`);
          await withObsidianPage(session.remoteDebuggingPort, async page => {
            const modal = page.locator('.modal-container').filter({ has: page.getByRole('button', { name: 'Not now', exact: true }) }).last();
            await modal.waitFor({ state: 'visible', timeout: 15000 });
            await modal.screenshot({ path: join(output, `${scenario.name}-dialogue.png`) });
            // Exercise the user's actual dialogue, not a direct revision deletion.
            await modal.getByRole('button', { name: 'Concat both', exact: true }).click();
          });
          await evaluate(session, 'await core.services.conflict.ensureAllProcessed();return JSON.stringify({ok:true});');
          await sync(session); await stop(session);
          expected = (await data('read_file', { path })).content;
        }
        for (const vault of [a, b]) {
          session = await start(vault); await sync(session); await waitContent(vault, path, expected); await stop(session);
        }
        const after = await tree(path);
        assert.equal(after.leaves.length, 1);
        evidence.cases.push({ case: scenario.name, passed: true, before: before.leaves.length, after: 1,
          mcpCode: result.structuredContent.error.code,
          contentSha256: createHash('sha256').update(expected).digest('hex') });
        console.log(`Passed disposable case: ${scenario.name}`);
      }
      evidence.acceptance = 'core_matrix_passed_remaining_gates_pending';
      phase = 'binary_host_policy';
      // Tiny valid GIFs (one pixel, distinct palette colours) exercise ordinary
      // image chunking; no attachment payload is returned to an MCP model.
      const imageA = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
      const imageB = Buffer.from(imageA, 'base64'); imageB[13] = 255;
      const imageC = Buffer.from(imageA, 'base64'); imageC[14] = 255;
      const imagePath = 'staging-image.gif';
      const binaryEdit = async (session, encoded) => {
        await evaluate(session, `const path=${JSON.stringify(imagePath)};
          const bytes=Uint8Array.from(atob(${JSON.stringify(encoded)}), c=>c.charCodeAt(0)).buffer;
          const file=app.vault.getAbstractFileByPath(path);
          if(file) await app.vault.modifyBinary(file,bytes);else await app.vault.createBinary(path,bytes);
          await core.services.fileProcessing.commitPendingFileEvents();return JSON.stringify({ok:true});`);
        await workflow.waitForLocalDatabaseEntry(cliBinary, session.cliEnv, imagePath);
      };
      session = await start(a); await binaryEdit(session, imageA); await sync(session); await stop(session);
      session = await start(b); await sync(session); await stop(session);
      for (const [vault, bytes] of [[a, imageB], [b, imageC]]) {
        session = await start(vault); await binaryEdit(session, bytes.toString('base64')); await sync(session); await stop(session);
      }
      const binaryBefore = await tree(imagePath);
      assert.equal(binaryBefore.leaves.length, 2);
      const binaryResult = await call(reader, 'read_attachment', { path: imagePath });
      assert.equal(binaryResult.structuredContent?.error?.code, 'livesync_conflict');
      assert.deepEqual(await tree(imagePath), binaryBefore);
      session = await start(b); await sync(session);
      await evaluate(session, `const file=app.vault.getAbstractFileByPath(${JSON.stringify(imagePath)});
        if(file) await app.workspace.getLeaf(false).openFile(file);
        await core.services.conflict.queueCheckFor(${JSON.stringify(imagePath)});
        await core.services.conflict.ensureAllProcessed();return JSON.stringify({ok:true});`);
      await sync(session); await stop(session);
      assert.equal((await tree(imagePath)).leaves.length, 1);
      for (const vault of [a, b]) {
        session = await start(vault); await sync(session);
        assert.deepEqual(await readFile(join(vault.path, imagePath)), imageC);
        await stop(session);
      }
      evidence.cases.push({ case: 'binary_host_policy', passed: true, before: 2, after: 1 });
      evidence.pending = ['token_revocation', 'write_switch_off', 'rollback_and_replication'];
    }
  }
} catch (error) {
  evidence.acceptance = 'failed'; evidence.failedPhase = phase;
  evidence.failedOperation = operation;
  if (output) await writeFile(join(output, 'private-error.txt'), String(error.stack ?? error), { mode: 0o600 });
  // Store only source locations, never assertion values or upstream messages.
  evidence.failureLocations = String(error.stack ?? '').split('\n')
    .filter(line => /^\s+at /.test(line) && line.includes('/scripts/staging/'));
  // Upstream errors may contain credentials or vault content; never dump them.
  console.error(`Staging stopped during ${phase}. ${phase === 'configuration' ? error.message : 'Inspect the isolated evidence locally; no remote cleanup was attempted.'}`);
  process.exitCode = 1;
} finally {
  let stopped = true;
  for (const session of active) {
    try { await session.app.stop(); } catch { stopped = false; }
  }
  for (const client of clients) await client.close().catch(() => {});
  if (stopped) for (const vault of vaults) {
    if (canDisposeStagingVault(vault)) await vault.dispose();
    else { stopped = false; process.exitCode = 1; }
  }
  else { evidence.cleanup = 'client_stop_failed_profiles_preserved'; process.exitCode = 1; }
  if (output) {
    await writeFile(join(output, 'report.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.log(`Local evidence (contains disposable backups; do not commit): ${output}`);
  }
}
