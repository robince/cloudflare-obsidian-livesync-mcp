import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { it, expect } from 'vitest';
import PouchDB from 'pouchdb-core';
import HttpPouch from 'pouchdb-adapter-http';
import replication from 'pouchdb-replication';
import { expectCounts } from './backup-helpers';
import type { PouchDatabase } from '../src/index';

const ReplicationClient = PouchDB.plugin(HttpPouch).plugin(replication);
async function target() { return env.POUCH_DATABASES.getByName(`replication-restore-${crypto.randomUUID()}`); }
async function seed() {
  const source = await target();
  await runInDurableObject(source, (db: PouchDatabase) => { db['env'].BACKUP_DATABASE = 'vault'; });
  await source.ensureDatabase('vault');
  await source.putDocument('vault', { _id: 'original' });
  await source.putDocument('vault', { _id: '_local/obsydian_livesync_milestone' });
  return source;
}
  it('replicates writes and deletions into a restored database with exact counts', async () => {
    const source = await seed(), m = await source.createBackup('vault');
    if (!('id' in m)) throw new Error('Expected backup');
    const restored = await target();
    await restored.restoreBackup('replica', 'vault', m.id);
    const remote = (stub: typeof source, name: string) => new ReplicationClient(`https://local/${name}`, {
      adapter: 'http', skip_setup: true,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init), url = new URL(request.url);
        url.pathname = url.pathname.slice(name.length + 1) || '/';
        const headers = new Headers(request.headers); headers.set('x-pouchdb-database', name);
        return stub.fetch(new Request(url, new Request(request, { headers })));
      },
    } as PouchDB.Configuration.RemoteDatabaseConfiguration);
    const from = remote(source, 'vault'), to = remote(restored, 'replica');
    const before = await expectCounts(restored, 'replica');
    const created = await from.put({ _id: 'replication-after-restore' });
    expect((await (ReplicationClient as typeof PouchDB & { replicate(source: PouchDB.Database, target: PouchDB.Database): Promise<{ ok: boolean }> }).replicate(from, to)).ok).toBe(true);
    expect(await expectCounts(restored, 'replica')).toBe(before + 1);
    await from.remove('replication-after-restore', created.rev);
    expect((await (ReplicationClient as typeof PouchDB & { replicate(source: PouchDB.Database, target: PouchDB.Database): Promise<{ ok: boolean }> }).replicate(from, to)).ok).toBe(true);
    expect(await expectCounts(restored, 'replica')).toBe(before);
    await from.close(); await to.close();
  });
