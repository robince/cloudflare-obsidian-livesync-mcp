import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import PouchDB from 'pouchdb-core';
import replication from 'pouchdb-replication';
import { describe, expect, it } from 'vitest';
import { open, scopedStorage, translate } from './multivault-poc/storage';

PouchDB.plugin(replication);

function replicate(source: PouchDB.Database, target: PouchDB.Database) {
  const pluginDatabase = source as PouchDB.Database & {
    replicate: { to(target: PouchDB.Database): Promise<{ docs_written: number }> };
  };
  return pluginDatabase.replicate.to(target);
}

function fresh() { return env.POUCH_DATABASES.getByName(`poc-${crypto.randomUUID()}`); }

describe('multi-vault SQLite proof of concept (not production support)', () => {
  it('demonstrates that names alone do not isolate the installed adapter', async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const a = open(state.storage, 'control-a');
      await a.put({ _id: 'same', value: 'a' });
      const b = open(state.storage, 'control-b');
      expect((await b.get('same')).value).toBe('a');
      await a.close(); await b.close();
    });
  });

  it('isolates documents, local checkpoints, sequences, attachments and concurrent writes', async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const a = open(scopedStorage(state.storage, 'a'), 'a');
      const b = open(scopedStorage(state.storage, 'b'), 'b');
      await Promise.all([a.info(), b.info()]);
      await Promise.all([a.put({ _id: 'same', value: 'a' }), b.put({ _id: 'same', value: 'b' })]);
      await Promise.all([a.put({ _id: '_local/checkpoint', value: 'a' }), b.put({ _id: '_local/checkpoint', value: 'b' })]);
      await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).put({ _id: `doc${i}` })));
      expect((await a.get('same')).value).toBe('a');
      expect((await b.get('same')).value).toBe('b');
      expect((await a.get('_local/checkpoint')).value).toBe('a');
      expect((await b.get('_local/checkpoint')).value).toBe('b');
      expect((await a.info()).doc_count).toBe(11);
      expect((await b.info()).doc_count).toBe(11);
      await a.put({ _id: 'attachment', _attachments: { 'x.txt': { content_type: 'text/plain', data: btoa('a content') } } });
      await b.put({ _id: 'attachment', _attachments: { 'x.txt': { content_type: 'text/plain', data: btoa('b content') } } });
      expect(await (await a.getAttachment('attachment', 'x.txt') as Blob).text()).toBe('a content');
      expect(await (await b.getAttachment('attachment', 'x.txt') as Blob).text()).toBe('b content');
      const before = (await b.info()).update_seq;
      await a.put({ _id: 'only-a' });
      expect((await b.info()).update_seq).toBe(before);
      const tables = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").toArray().map(r => r.name);
      expect(tables).toContain('a_document-store');
      expect(tables).toContain('b_document-store');
      expect(tables).not.toContain('document-store');
      await a.close(); await b.close();
    });
  });

  it('keeps the other vault intact through close, reopen, compaction and destroy', async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const sa = scopedStorage(state.storage, 'a');
      let a = open(sa, 'life-a');
      const b = open(scopedStorage(state.storage, 'b'), 'life-b');
      await a.put({ _id: 'same', value: 'a' });
      await b.put({ _id: 'same', value: 'b' });
      await a.close();
      a = open(sa, 'life-a');
      expect((await a.get('same')).value).toBe('a');
      await a.compact();
      await a.destroy();
      expect((await b.get('same')).value).toBe('b');
      await b.put({ _id: 'after-destroy' });
      a = open(sa, 'life-a');
      expect((await a.info()).doc_count).toBe(0);
      expect((await b.info()).doc_count).toBe(2);
      await a.close(); await b.close();
    });
  });

  it('isolates live change subscriptions and resumes replication checkpoints', async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const a = open(scopedStorage(state.storage, 'a'), 'feed-a');
      const b = open(scopedStorage(state.storage, 'b'), 'feed-b');
      const replica = open(scopedStorage(state.storage, 'replica'), 'feed-replica');
      await Promise.all([a.info(), b.info(), replica.info()]);
      const seenA: string[] = [], seenB: string[] = [];
      const feedA = a.changes({ live: true, since: 0 }).on('change', c => seenA.push(c.id));
      const feedB = b.changes({ live: true, since: 0 }).on('change', c => seenB.push(c.id));
      try {
        await a.put({ _id: 'only-a', value: 'document-store' });
        await b.put({ _id: 'only-b' });
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(seenA).toEqual(['only-a']);
        expect(seenB).toEqual(['only-b']);
        const first = await replicate(a, replica);
        expect(first.docs_written).toBe(1);
        expect((await replica.get('only-a')).value).toBe('document-store');
        expect((await replicate(a, replica)).docs_written).toBe(0);
        await a.put({ _id: 'next' });
        expect((await replicate(a, replica)).docs_written).toBe(1);
        await expect(replica.get('only-b')).rejects.toMatchObject({ status: 404 });
      } finally {
        feedA.cancel(); feedB.cancel();
        await Promise.all([feedA, feedB]);
        await a.close(); await b.close(); await replica.close();
      }
    });
  });

  it('persists independent identities and data across object eviction', async () => {
    const stub = fresh();
    const ids = await runInDurableObject(stub, async (_instance, state) => {
      const a = open(scopedStorage(state.storage, 'a'), 'evict-a');
      const b = open(scopedStorage(state.storage, 'b'), 'evict-b');
      await a.put({ _id: 'same', value: 'a' });
      await b.put({ _id: 'same', value: 'b' });
      const ids = state.storage.sql.exec<{ dbid: string }>('SELECT dbid FROM "a_metadata-store" UNION ALL SELECT dbid FROM "b_metadata-store"').toArray();
      expect(ids[0].dbid).not.toBe(ids[1].dbid);
      // Leave handles open: the host eviction must discard in-memory state.
      return ids;
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      const a = open(scopedStorage(state.storage, 'a'), 'evict-a');
      const b = open(scopedStorage(state.storage, 'b'), 'evict-b');
      expect((await a.get('same')).value).toBe('a');
      expect((await b.get('same')).value).toBe('b');
      expect(state.storage.sql.exec('SELECT dbid FROM "a_metadata-store" UNION ALL SELECT dbid FROM "b_metadata-store"').toArray()).toEqual(ids);
      await a.close(); await b.close();
    });
  });

  it('rolls back a failing transaction without discarding a concurrent vault write', async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const sa = scopedStorage(state.storage, 'a');
      const a = open(sa, 'rollback-a');
      const b = open(scopedStorage(state.storage, 'b'), 'rollback-b');
      await Promise.all([a.info(), b.info()]);
      const failed = sa.transaction(async () => {
        sa.sql.exec('INSERT INTO "local-store" (id,rev,json) VALUES (?,?,?)', 'rollback', '0-1', '{}');
        await Promise.resolve();
        throw new Error('injected rollback');
      });
      const results = await Promise.allSettled([failed, b.put({ _id: 'survives' })]);
      expect(results[0].status).toBe('rejected');
      expect(results[1].status).toBe('fulfilled');
      expect(sa.sql.exec('SELECT * FROM "local-store"').toArray()).toEqual([]);
      expect((await b.get('survives'))._id).toBe('survives');
      await a.put({ _id: 'after-rollback' });
      await a.close(); await b.close();
    });
  });

  it('isolates conflicting revisions, tombstones and purge allocation', async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const a = open(scopedStorage(state.storage, 'a'), 'rev-a');
      const b = open(scopedStorage(state.storage, 'b'), 'rev-b');
      await a.bulkDocs([{ _id: 'conflict', _rev: '1-a', value: 'a' }, { _id: 'conflict', _rev: '1-b', value: 'b' }], { new_edits: false });
      await b.put({ _id: 'conflict', value: 'independent' });
      expect((await a.get('conflict', { conflicts: true }))._conflicts).toEqual(['1-a']);
      const latest = await a.put({ _id: 'latest' });
      const high = (await a.info()).update_seq;
      const purge = a as typeof a & { purge(id: string, rev: string): Promise<unknown> };
      await purge.purge('latest', latest.rev);
      await a.compact();
      expect((await a.info()).update_seq).toBe(high);
      await a.put({ _id: 'after-purge' });
      expect(Number((await a.info()).update_seq)).toBeGreaterThan(Number(high));
      await b.remove(await b.get('conflict'));
      await expect(b.get('conflict')).rejects.toMatchObject({ status: 404 });
      expect((await a.get('conflict')).value).toBe('b');
      expect((await b.changes({ since: 0 })).results).toMatchObject([{ id: 'conflict', deleted: true }]);
      await a.close(); await b.close();
    });
  });

  it.each(['unscoped', 'scoped', 'concurrent'])('characterizes bulk failure persistence (%s)', async mode => {
    const concurrent = mode === 'concurrent';
    await runInDurableObject(fresh(), async (_instance, state) => {
      const scoped = mode === 'unscoped' ? state.storage : scopedStorage(state.storage, 'a');
      let armed = false;
      const sql = new Proxy(scoped.sql, { get(target, key) {
        if (key === 'exec') return (query: string, ...bindings: SqlStorageValue[]) => {
          const cursor = target.exec(query, ...bindings);
          if (armed && /INSERT INTO ['"]document-store['"]/.test(query)) {
            armed = false;
            throw new Error('injected after document insert');
          }
          return cursor;
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      const faultStorage = new Proxy(scoped, { get(target, key) {
        if (key === 'sql') return sql;
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      const a = open(faultStorage, 'fault-a');
      const b = open(scopedStorage(state.storage, 'b'), 'fault-b');
      await Promise.all([a.info(), b.info()]);
      armed = true;
      const results = await Promise.allSettled([
        a.bulkDocs([{ _id: 'failed1' }, { _id: 'failed2' }]),
        concurrent ? b.put({ _id: 'kept' }) : Promise.resolve(),
      ]);
      expect(armed).toBe(false);
      expect(results[0].status).toBe('rejected');
      expect(results[1].status).toBe('fulfilled');
      // Characterization of a pinned-adapter defect, not the desired contract.
      expect((await a.allDocs()).rows.map(row => row.id)).toEqual(['failed1', 'failed2']);
      expect((await a.info()).doc_count).toBe(2);
      if (concurrent) expect((await b.get('kept'))._id).toBe('kept');
      await a.put({ _id: 'recovered' });
      await a.close(); await b.close();
    });
  });

  it('demonstrates same-name listener interference despite separate table namespaces', async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const a = open(scopedStorage(state.storage, 'a'), 'shared-name');
      const b = open(scopedStorage(state.storage, 'b'), 'shared-name');
      await Promise.all([a.info(), b.info()]);
      const seen: string[] = [];
      const feed = a.changes({ live: true, since: 0 }).on('change', change => seen.push(change.id));
      await a.put({ _id: 'before' });
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(seen).toEqual(['before']);
      await b.destroy();
      await a.put({ _id: 'after' });
      await new Promise(resolve => setTimeout(resolve, 30));
      // Known unsafe configuration: destroy removes listeners keyed by name.
      expect(seen).toEqual(['before']);
      expect((await a.changes({ since: 0 })).results.map(row => row.id)).toEqual(['before', 'after']);
      feed.cancel(); await feed;
      await a.close();
    });
  });

  it('handles eight vaults and 400 interleaved writes without cross-vault rows', async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const dbs = Array.from({ length: 8 }, (_, i) => open(scopedStorage(state.storage, `v${i}`), `load-${i}`));
      await Promise.all(dbs.map(db => db.info()));
      await Promise.all(dbs.map(async (db, i) => {
        for (let n = 0; n < 50; n++) await db.put({ _id: `same${n}`, value: `vault${i}` });
      }));
      for (let i = 0; i < dbs.length; i++) {
        const result = await dbs[i].allDocs({ include_docs: true });
        expect(result.rows).toHaveLength(50);
        expect(result.rows.every(row => row.doc?.value === `vault${i}`)).toBe(true);
        await dbs[i].close();
      }
    });
  });

  it('rejects unsafe namespace identifiers', () => {
    expect(() => translate('SELECT 1', 'a;DROP')).toThrow('Invalid test namespace');
  });
});
