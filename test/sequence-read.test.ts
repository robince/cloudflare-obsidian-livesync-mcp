import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { readUpdateSequence } from '../src/changes-feed';
import type { PouchDatabase } from '../src/pouch-database';

const sequenceSql = "SELECT seq FROM sqlite_sequence WHERE name='by-sequence'";
const countSql = 'SELECT COUNT("document-store".id) AS num FROM "document-store" JOIN "by-sequence" ON "by-sequence".seq="document-store".winningseq WHERE "by-sequence".deleted=0';

function fresh() { return env.POUCH_DATABASES.getByName(`sequence-${crypto.randomUUID()}`); }
function request(path: string, init: RequestInit = {}) {
  return new Request(`https://sequence.invalid${path}`, {
    ...init, headers: { 'x-pouchdb-database': 'vault' },
  });
}

// Keep the actual cursors: callers consume them normally, and rowsRead is sampled
// only after the operation (including response streaming) has finished.
async function measure<T>(sql: SqlStorage, action: () => Promise<T>, recount = false) {
  const original = sql.exec;
  const queries: string[] = [];
  const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
  sql.exec = ((query: string, ...bindings: SqlStorageValue[]) => {
    // Reproduce the old info() count at each sequence snapshot, on the same poll.
    if (recount && query === sequenceSql) {
      const count = original.call(sql, countSql);
      count.toArray();
      cursors.push(count);
    }
    const cursor = original.call(sql, query, ...bindings);
    queries.push(query);
    cursors.push(cursor);
    return cursor;
  }) as SqlStorage['exec'];
  try {
    const value = await action();
    return { value, rowsRead: cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0), queries };
  } finally { sql.exec = original; }
}

async function equivalent(instance: PouchDatabase) {
  const db = instance['database']();
  const seq = await readUpdateSequence(db, instance['ctx'].storage.sql);
  expect(seq).toBe(Number((await db.info()).update_seq));
  return seq;
}

describe('persisted update sequence', () => {
  it('answers database HEAD probes without initializing PouchDB or scanning documents', async () => {
    const stub = fresh();
    expect((await stub.fetch(request('/', { method: 'HEAD' }))).status).toBe(404);
    await stub.ensureDatabase('vault');
    await runInDurableObject(stub, async (instance: PouchDatabase) => {
      await instance['database']().bulkDocs(
        Array.from({ length: 100 }, (_, i) => ({ _id: `head-${i}` })),
      );
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance: PouchDatabase) => {
      const sql = instance['ctx'].storage.sql;
      expect(instance['db']).toBeUndefined();
      const head = await measure(sql, async () => {
        const response = await instance.fetch(request('/', { method: 'HEAD' }));
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('');
      });
      expect(instance['db']).toBeUndefined();
      expect(head.rowsRead).toBeLessThanOrEqual(2);
      expect(head.queries.every((query) => query.includes('cloudflare_pouchdb_meta'))).toBe(true);
      const mismatch = await measure(sql, async () => {
        const probe = request('/', { method: 'HEAD' });
        probe.headers.set('x-pouchdb-database', 'another-vault');
        const response = await instance.fetch(probe);
        expect(response.status).toBe(409);
      });
      expect(instance['db']).toBeUndefined();
      expect(mismatch.rowsRead).toBeLessThanOrEqual(2);
      expect(mismatch.queries.every((query) => query.includes('cloudflare_pouchdb_meta'))).toBe(true);
      const get = await instance.fetch(request('/'));
      expect(get.status).toBe(200);
      expect(await get.json()).toMatchObject({ doc_count: 100, update_seq: 100 });
    });
  });

  it('waits for cold initialization and survives revision maintenance and object eviction', async () => {
    const stub = fresh();
    const last = await runInDurableObject(stub, async (instance: PouchDatabase) => {
      const sql = instance['ctx'].storage.sql;
      // No ensureDatabase/info/id call has initialized the adapter yet.
      const cold = await measure(sql, () => readUpdateSequence(instance['database']('vault'), sql));
      expect(cold.value).toBe(0);
      expect(cold.rowsRead).toBe(18); // Schema 2 reads the persisted count during initialization.
      expect(cold.queries.some((query) => query.includes('CREATE TABLE'))).toBe(true);
      const db = instance['database']();
      expect(await equivalent(instance)).toBe(0);
      const first = await db.put({ _id: 'ordinary', value: 1 });
      expect(await equivalent(instance)).toBeGreaterThan(0);
      await db.put({ _id: 'ordinary', _rev: first.rev, value: 2 });
      await db.bulkDocs([
        { _id: 'conflict', _rev: '1-a', value: 'a' },
        { _id: 'conflict', _rev: '1-b', value: 'b' },
      ], { new_edits: false });
      await equivalent(instance);
      const doc = await db.get('ordinary');
      await db.remove(doc);
      const deleted = await equivalent(instance);
      expect((await db.info()).doc_count).toBe(1);
      await db.compact();
      expect(await equivalent(instance)).toBe(deleted);
      const latest = await db.put({ _id: 'latest', value: true });
      const high = await equivalent(instance);
      await db.purge('latest', latest.rev);
      expect(await equivalent(instance)).toBe(high);
      expect(sql.exec<{ n: number }>('SELECT MAX(seq) AS n FROM "by-sequence"').one().n).toBeLessThan(high);
      return high;
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance: PouchDatabase) => {
      expect(instance['db']).toBeUndefined();
      expect(await equivalent(instance)).toBe(last);
      await instance['database']().put({ _id: 'after-eviction' });
      expect(await equivalent(instance)).toBeGreaterThan(last);
    });
  });

  it('preserves the allocation high-water mark through backup and restore', async () => {
    const source = fresh();
    await source.ensureDatabase('vault');
    const before = await runInDurableObject(source, async (instance: PouchDatabase) => {
      const db = instance['database']();
      await db.put({ _id: '_local/obsydian_livesync_milestone', locked: false });
      await db.put({ _id: 'kept' });
      const latest = await db.put({ _id: 'purged' });
      await db.purge('purged', latest.rev);
      return equivalent(instance);
    });
    const backup = await source.createBackup('vault');
    if (!('id' in backup)) throw new Error('Expected backup');
    const target = fresh();
    await target.restoreBackup('restored', 'vault', backup.id);
    await runInDurableObject(target, async (instance: PouchDatabase) => {
      // Restore updates a local lock document, which must not advance sequence.
      expect(await equivalent(instance)).toBe(before);
      const seq = await equivalent(instance);
      await instance['database']().put({ _id: 'after-restore' });
      expect(await equivalent(instance)).toBeGreaterThan(seq);
    });
  });

  it('rejects invalid persisted values and propagates SQL and readiness failures', async () => {
    await runInDurableObject(fresh(), async (instance: PouchDatabase) => {
      const db = instance['database']('vault');
      const sql = instance['ctx'].storage.sql;
      await db.put({ _id: 'seed' });
      for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, 'invalid', null]) {
        sql.exec("UPDATE sqlite_sequence SET seq=? WHERE name='by-sequence'", value);
        await expect(readUpdateSequence(db, sql)).rejects.toThrow('Invalid database update sequence');
      }
      sql.exec("UPDATE sqlite_sequence SET seq=1 WHERE name='by-sequence'");
      sql.exec("INSERT INTO sqlite_sequence(name,seq) VALUES ('by-sequence',2)");
      await expect(readUpdateSequence(db, sql)).rejects.toThrow('Invalid database update sequence');
      sql.exec("DELETE FROM sqlite_sequence WHERE name='by-sequence'");
      expect(await readUpdateSequence(db, sql)).toBe(0);
      const original = sql.exec;
      sql.exec = () => { throw new Error('SQL unavailable'); };
      try { await expect(readUpdateSequence(db, sql)).rejects.toThrow('SQL unavailable'); }
      finally { sql.exec = original; }
      const id = db.id;
      db.id = () => Promise.reject(new Error('Initialization failed'));
      try { await expect(readUpdateSequence(db, sql)).rejects.toThrow('Initialization failed'); }
      finally { db.id = id; }
    });
  });

  it('observes completed writes when reads overlap adapter transactions', async () => {
    await runInDurableObject(fresh(), async (instance: PouchDatabase) => {
      const db = instance['database']('vault');
      const sql = instance['ctx'].storage.sql;
      for (let batch = 0; batch < 5; batch++) {
        const before = await readUpdateSequence(db, sql);
        const writing = db.bulkDocs(Array.from({ length: 10 }, (_, i) => ({ _id: `${batch}-${i}` })));
        const during = await readUpdateSequence(db, sql);
        await writing;
        const after = await equivalent(instance);
        expect(during).toBeGreaterThanOrEqual(before);
        expect(during).toBeLessThanOrEqual(after);
        expect(after).toBe(before + 10);
      }
    });
  });

  it.each([10, 100, 1_000])('keeps sequence and empty-poll reads constant with %i documents', async (size) => {
    const stub = fresh();
    await stub.ensureDatabase('vault');
    await runInDurableObject(stub, async (instance: PouchDatabase) => {
      const seeded = await instance.fetch(request('/_bulk_docs', {
        method: 'POST', body: JSON.stringify({ docs: Array.from({ length: size }, (_, i) => ({ _id: `doc-${i}` })) }),
      }));
      expect(seeded.status).toBe(201);
      expect(await seeded.json()).toHaveLength(size);
      const db = instance['database']();
      const sql = instance['ctx'].storage.sql;
      await db.id();
      const count = await measure(sql, async () => sql.exec(countSql).toArray());
      expect(count.rowsRead).toBe(2 * size);
      const seq = await measure(sql, () => readUpdateSequence(db, sql));
      expect(seq.queries).toEqual([sequenceSql]);
      expect(seq.rowsRead).toBe(1);
      const poll = async () => {
        const response = await instance.fetch(request(`/_changes?feed=longpoll&since=${seq.value}&timeout=20`));
        expect(response.status).toBe(200);
        return response.json();
      };
      const before = await measure(sql, poll, true);
      const after = await measure(sql, poll);
      expect(after.value).toEqual({ results: [], last_seq: seq.value, pending: 0 });
      expect(before.value).toEqual(after.value);
      expect(before.rowsRead - after.rowsRead).toBe(4 * size);
      expect(after.rowsRead).toBeLessThan(20);
      expect(after.rowsRead).toBe(8);
      expect(after.queries.filter((query) => query === sequenceSql)).toHaveLength(2);
      const now = await measure(sql, async () => (await instance.fetch(request('/_changes?feed=longpoll&since=now&timeout=20'))).json());
      expect(now.rowsRead).toBe(9);
      expect(now.value).toEqual(after.value);
      const plan = sql.exec('EXPLAIN QUERY PLAN SELECT id,max_seq FROM "document-store" WHERE max_seq>? AND max_seq<=? ORDER BY max_seq LIMIT 16', seq.value, seq.value).toArray();
      expect(JSON.stringify(plan)).toContain('sqlite_autoindex_document-store_2');
      const countPlan = sql.exec(`EXPLAIN QUERY PLAN ${countSql}`).toArray();
      expect(JSON.stringify(countPlan)).toContain('SCAN document-store');
      expect((await (await instance.fetch(request('/'))).json() as { doc_count: number }).doc_count).toBe(size);
    });
  });

  it.each(['before registration', 'during wait', 'cancel'] as const)('handles %s without missed changes or hanging polls', async (when) => {
    const stub = fresh();
    await stub.ensureDatabase('vault');
    await runInDurableObject(stub, async (instance: PouchDatabase) => {
      const db = instance['database']();
      await db.id();
      const controller = new AbortController();
      const original = db.changes;
      let registered!: () => void;
      const registration = new Promise<void>((resolve) => { registered = resolve; });
      let writing: Promise<unknown> | undefined;
      db.changes = ((options) => {
        if (options?.live) {
          // Queue the write before PouchDB queues the listener's initial query.
          if (when === 'before registration') writing = db.put({ _id: 'arrived' });
          const feed = original.call(db, options);
          registered();
          return feed;
        }
        return original.call(db, options ?? undefined);
      }) as typeof db.changes;
      try {
        // Longer than the test deadline: a missed wake-up must fail, not merely
        // find the write in the second snapshot after a short poll timeout.
        const pending = instance.fetch(request('/_changes?feed=longpoll&since=now&timeout=55000', { signal: controller.signal }));
        await registration;
        if (when === 'during wait') {
          await new Promise((resolve) => setTimeout(resolve, 10));
          writing = db.put({ _id: 'arrived' });
        }
        if (when === 'cancel') controller.abort();
        await writing;
        const response = await pending;
        if (when !== 'cancel') {
          const body = await response.json() as { results: { id: string }[]; last_seq: number };
          expect(body.results.map((row) => row.id)).toEqual(['arrived']);
          expect(body.last_seq).toBe(await equivalent(instance));
        } else { await response.text(); }
        expect(instance['activeChangeLongpolls']).toBe(0);
      } finally { db.changes = original; controller.abort(); }
    });
  });

  it('preserves future checkpoints, filters, limits and descending traversal', async () => {
    const stub = fresh();
    await stub.ensureDatabase('vault');
    await runInDurableObject(stub, async (instance: PouchDatabase) => {
      const db = instance['database']();
      await db.bulkDocs([{ _id: 'a', selected: true }, { _id: 'b', selected: false }, { _id: 'c', selected: true }]);
      const page = async (query: string, body?: object) => (await instance.fetch(request(`/_changes?${query}`, body ? { method: 'POST', body: JSON.stringify(body) } : {}))).json() as Promise<{ results: { id: string }[]; last_seq: number; pending: number }>;
      expect(await page('since=999')).toEqual({ results: [], last_seq: 999, pending: 0 });
      expect(await page('since=now')).toEqual({ results: [], last_seq: 3, pending: 0 });
      expect((await page('')).results.map((row) => row.id)).toEqual(['a', 'b', 'c']);
      const first = await page('descending=true&limit=1', { selector: { selected: true } });
      expect(first.results.map((row) => row.id)).toEqual(['c']);
      expect((await page(`descending=true&since=${first.last_seq}&limit=1`, { doc_ids: ['a'] })).results.map((row) => row.id)).toEqual(['a']);
    });
  });
});
