import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { PouchDatabase } from '../src/pouch-database';
import { scopedState } from './multivault-poc/storage';
import fixture from './fixtures/livesync-1.0.21.json';

function context(state: DurableObjectState, namespace: string) {
  const vault = new PouchDatabase(state, env);
  Object.defineProperty(vault, 'ctx', { value: scopedState(state, namespace) });
  vault['ctx'].storage.sql.exec('CREATE TABLE IF NOT EXISTS cloudflare_pouchdb_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  return vault;
}

function fresh() { return env.POUCH_DATABASES.getByName(`app-poc-${crypto.randomUUID()}`); }
function request(name: string, path: string, signal?: AbortSignal) {
  return new Request(`https://poc.invalid/${path}`, { headers: { 'x-pouchdb-database': name }, signal });
}
async function ready(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for test barrier');
}
async function seed(vault: PouchDatabase, name: string) {
  await vault.ensureDatabase(name);
  for (const doc of [...fixture.documents, ...Object.values(fixture.localDocuments)]) {
    const copy: Record<string, unknown> = structuredClone(doc);
    delete copy._rev; delete copy._revisions;
    await vault.putDocument(name, copy);
  }
}
async function close(...vaults: PouchDatabase[]) {
  for (const v of vaults) if (v['db']) await v['db'].close();
}

describe('multiple application vault contexts inside one real DO', () => {
  it('isolates real HTTP long polls, allows writes, handles timeout and cancellation', async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const a = context(state, 'a');
      const b = context(state, 'b');
      await a.ensureDatabase('a'); await b.ensureDatabase('b');
      const controller = new AbortController();
      const pa = a.fetch(request('a', '_changes?feed=longpoll&since=now&timeout=2000'));
      const pb = b.fetch(request('b', '_changes?feed=longpoll&since=now&timeout=2000', controller.signal));
      await ready(() => a['activeChangeLongpolls'] === 1 && b['activeChangeLongpolls'] === 1);
      await a.putDocument('a', { _id: 'only-a' });
      const ra = await pa;
      expect(await ra.json()).toMatchObject({ results: [{ id: 'only-a' }] });
      expect(b['activeChangeLongpolls']).toBe(1);
      controller.abort();
      const rb = await pb;
      await rb.text();
      expect(b['activeChangeLongpolls']).toBe(0);
      const timeout = await b.fetch(request('b', '_changes?feed=longpoll&since=now&timeout=20'));
      expect(await timeout.json()).toMatchObject({ results: [] });
      await b.putDocument('b', { _id: 'after-cancel' });
      expect(await b.getDocument('b', 'after-cancel')).toMatchObject({ _id: 'after-cancel' });
      await close(a, b);
    });
  });

  it('separates Commonlib note writes and derived FTS with identical note paths', async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const a = context(state, 'a');
      const b = context(state, 'b');
      await seed(a, 'a'); await seed(b, 'b');
      const writes = await Promise.all([
        a.createVaultFile({ path: 'notes/unique.md', content: 'amberonly' }),
        b.createVaultFile({ path: 'notes/unique.md', content: 'violetonly' }),
      ]);
      expect(writes).toMatchObject([{ ok: true }, { ok: true }]);
      expect(await a.readVaultFile({ path: 'notes/unique.md' })).toMatchObject({ ok: true, data: { content: 'amberonly' } });
      expect(await b.readVaultFile({ path: 'notes/unique.md' })).toMatchObject({ ok: true, data: { content: 'violetonly' } });
      expect(await a.searchVaultFiles({ query: 'amberonly' })).toMatchObject({ ok: true, data: { results: [{ path: 'notes/unique.md' }] } });
      expect(await b.searchVaultFiles({ query: 'amberonly' })).toMatchObject({ ok: true, data: { results: [] } });
      expect(await b.searchVaultFiles({ query: 'violetonly' })).toMatchObject({ ok: true, data: { results: [{ path: 'notes/unique.md' }] } });
      await close(a, b);
    });
  });
  it('backs up one namespace and restores into a third while preserving the neighbour', async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const a = context(state, 'a');
      const b = context(state, 'b');
      const restored = context(state, 'restored');
      // Existing backup configuration is per instance in this test harness.
      Object.defineProperty(a, 'env', { value: { ...env, BACKUP_DATABASE: 'a' } });
      await seed(a, 'a'); await seed(b, 'b');
      expect(await a.createVaultFile({ path: 'notes/backup.md', content: 'sourceonly' })).toMatchObject({ ok: true });
      expect(await b.createVaultFile({ path: 'notes/backup.md', content: 'neighbouronly' })).toMatchObject({ ok: true });
      const before = await b.readVaultFile({ path: 'notes/backup.md' });
      const backup = await a.createBackup('a');
      if ('skipped' in backup) throw new Error('Unexpected skip');
      expect(await restored.restoreBackup('restored', 'a', backup.id)).toMatchObject({ ok: true });
      expect(await b.readVaultFile({ path: 'notes/backup.md' })).toEqual(before);
      expect(await restored.readVaultFile({ path: 'notes/backup.md' })).toMatchObject({ ok: true, data: { content: 'sourceonly' } });
      await b.putDocument('b', { _id: 'still-writable' });
      await close(a, b, restored);
    });
  });

});
