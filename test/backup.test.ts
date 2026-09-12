import { env } from 'cloudflare:workers';
import { runInDurableObject, evictDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker, { PouchDatabase } from '../src/index';
import { listBackups, verifyBackup, directory } from '../src/backup/storage';
import { pack, unpack, hash } from '../src/backup/format';
import fixture from './fixtures/livesync-1.0.21.json';

async function seed() {
  const stub = env.POUCH_DATABASES.getByName(`backup-source-${crypto.randomUUID()}`);
  await runInDurableObject(stub, (db: PouchDatabase) => { db['env'].BACKUP_DATABASE = 'vault'; });
  await stub.ensureDatabase('vault');
  for (const doc of [...fixture.documents, ...Object.values(fixture.localDocuments)]) {
    const copy = { ...doc } as Record<string, unknown>; delete copy._rev;
    await stub.putDocument('vault', copy);
  }
  return stub;
}
async function target() { return env.POUCH_DATABASES.getByName(`restore-${crypto.randomUUID()}`); }

async function expectCounts(stub: Awaited<ReturnType<typeof target>>, name: string) {
  const result = await runInDurableObject(stub, async (db: PouchDatabase) => {
    const oracle = db['ctx'].storage.sql.exec<{ num: number }>(`SELECT COUNT(d.id) AS num
      FROM "document-store" d JOIN "by-sequence" b ON b.seq = d.winningseq WHERE b.deleted = 0`).one().num;
    const adapter = db['database'](name);
    return { oracle, info: (await adapter.info()).doc_count, rows: (await adapter.allDocs()).total_rows,
      meta: db['ctx'].storage.sql.exec('SELECT db_version, doc_count FROM "metadata-store"').one() };
  });
  expect(result.info).toBe(result.oracle);
  expect(result.rows).toBe(result.oracle);
  expect(result.meta).toEqual({ db_version: 2, doc_count: result.oracle });
  return result.oracle;
}

describe('database backups', () => {
  it('round-trips retained revisions, chunks, metadata, tombstones and attachments into a locked fresh target', async () => {
    const source = await seed();
    const first = await source.putDocument('vault', { _id: 'history', value: 'before' });
    await source.putDocument('vault', { _id: 'history', _rev: first.rev, value: 'after' });
    const deleted = await source.putDocument('vault', { _id: 'deleted', value: 'old' });
    await source.putDocument('vault', { _id: 'deleted', _rev: deleted.rev, _deleted: true });
    await source.putDocument('vault', { _id: 'attachment', _attachments: { 'a.bin': { content_type: 'application/octet-stream', data: 'AAEC/w==' } } });
    await source.putDocument('vault', { _id: '_local/checkpoint', last_seq: 17 });
    await source.putDocument('vault', { _id: '_design/example', views: {} });
    const m = await source.createBackup('vault');
    if (!('id' in m)) throw new Error('Expected backup');
    await verifyBackup(env.BACKUP_BUCKET, m);
    expect(m.format).toBe(2);
    expect(m.adapter).toBe('1.1.2-cloudflare-do.1');
    expect(m.pauseMs).toBeLessThan(60_000);
    expect(m.tables['by-sequence']).toBeGreaterThan(0);
    const restored = await target();
    await restored.restoreBackup('restored', 'vault', m.id);
    await expect(restored.getDocument('restored', 'history', { rev: first.rev })).resolves.toMatchObject({ value: 'before' });
    await expect(restored.getDocument('restored', 'history')).resolves.toMatchObject({ value: 'after' });
    await expect(restored.getDocument('restored', '_local/checkpoint')).resolves.toMatchObject({ last_seq: 17 });
    expect(await runInDurableObject(restored, async (db: PouchDatabase) => { try { await db.getDocument('restored', 'deleted'); } catch { return 'deleted'; } })).toBe('deleted');
    const attachment = await restored.getDocument('restored', 'attachment', { attachments: true });
    expect(attachment).toMatchObject({ _attachments: { 'a.bin': { data: 'AAEC/w==' } } });
    await expect(restored.getDocument('restored', '_local/obsydian_livesync_milestone')).resolves.toMatchObject({ locked: true, accepted_nodes: [], cleaned: false });
    expect(await restored.readVaultFile({ path: 'notes/unicode-雪.md' })).toMatchObject({ ok: true });
    expect(await runInDurableObject(restored, async (db: PouchDatabase) => { try { await db.restoreBackup('restored', 'vault', m.id); } catch { return 'refused'; } })).toBe('refused');
    const before = await expectCounts(restored, 'restored');
    const next = await restored.putDocument('restored', { _id: 'new', value: true });
    expect(next.ok).toBe(true);
    expect(await expectCounts(restored, 'restored')).toBe(before + 1);
    await restored.putDocument('restored', { _id: 'new', _rev: next.rev, _deleted: true });
    expect(await expectCounts(restored, 'restored')).toBe(before);
    // Replication protocol writes preserve conflicting leaves and resurrect tombstones.
    const response = await restored.fetch(new Request('https://local/_bulk_docs', {
      method: 'POST', headers: { 'x-pouchdb-database': 'restored' },
      body: JSON.stringify({ new_edits: false, docs: [
        { _id: 'replicated', _rev: '1-aaaa' }, { _id: 'replicated', _rev: '1-bbbb' },
        { _id: 'deleted', _rev: '3-live', _revisions: { start: 3, ids: ['live', 'dead', 'old'] } },
      ] }),
    }));
    expect(response.status).toBe(201);
    expect(await expectCounts(restored, 'restored')).toBe(before + 2);
  });

  it('serves no requests and holds no adapter handle during import', async () => {
    const source = await seed(), m = await source.createBackup('vault');
    if (!('id' in m)) throw new Error('Expected backup');
    const restored = await target();
    const result = await runInDurableObject(restored, async (db: PouchDatabase) => {
      const bucket = db['env'].BACKUP_BUCKET;
      let enter!: () => void, release!: () => void, reads = 0;
      const entered = new Promise<void>(r => enter = r), released = new Promise<void>(r => release = r);
      db['env'].BACKUP_BUCKET = new Proxy(bucket, { get(object, key) {
        if (key === 'get') return async (...args: Parameters<R2Bucket['get']>) => {
          if (String(args[0]).endsWith('.jsonl.gz') && ++reads === m.parts.length + 1) { enter(); await released; }
          return object.get(...args);
        };
        const value = Reflect.get(object, key); return typeof value === 'function' ? value.bind(object) : value;
      } });
      const restoring = db.restoreBackup('gated', 'vault', m.id);
      await entered;
      try {
        expect(db['db']).toBeUndefined();
        const response = await db.fetch(new Request('https://local/_all_docs', { headers: { 'x-pouchdb-database': 'gated' } }));
        const write = await db.putDocument('gated', { _id: 'blocked' }).then(() => true, () => false);
        const read = await db.getDocument('gated', 'blocked').then(() => true, () => false);
        return { status: response.status, write, read };
      } finally { release(); await restoring; db['env'].BACKUP_BUCKET = bucket; }
    });
    expect(result).toEqual({ status: 503, write: false, read: false });
    await expectCounts(restored, 'gated');
  });

  it('keeps corrupted restores inaccessible and supports explicit restart', async () => {
    const source = await seed(), m = await source.createBackup('vault');
    if (!('id' in m)) throw new Error('Expected backup');
    const key = `${directory('vault', m.id)}${m.parts[0].file}`;
    const original = await env.BACKUP_BUCKET.get(key);
    const bytes = await original!.arrayBuffer();
    await env.BACKUP_BUCKET.put(key, 'corrupt');
    const restored = await target();
    expect(await runInDurableObject(restored, async (db: PouchDatabase) => { try { await db.restoreBackup('recovery', 'vault', m.id); } catch { return 'refused'; } })).toBe('refused');
    expect(await runInDurableObject(restored, async (db: PouchDatabase) => { try { await db.ensureDatabase('recovery'); } catch { return 'refused'; } })).toBe('refused');
    const response = await restored.fetch(new Request('https://local/', { headers: { 'x-pouchdb-database': 'recovery' } }));
    expect(response.status).toBe(503);
    expect((await restored.readVaultFile({ path: 'notes/frontmatter.md' })).ok).toBe(false);
    await env.BACKUP_BUCKET.put(key, bytes);
    expect(await runInDurableObject(restored, async (db: PouchDatabase) => { try { await db.restoreBackup('recovery', 'vault', m.id); } catch { return 'refused'; } })).toBe('refused');
    await expect(restored.restoreBackup('recovery', 'vault', m.id, true)).resolves.toMatchObject({ ok: true });
  });

  it('restarts a target interrupted after some tables have been imported', async () => {
    const source = await seed();
    for (let i = 0; i < 12; i++) await source.putDocument('vault', { _id: `partial-${i}`, data: 'x'.repeat(400_000) });
    const m = await source.createBackup('vault');
    if (!('id' in m)) throw new Error('Expected backup');
    expect(m.parts.length).toBeGreaterThan(1);
    const restored = await target();
    const interrupted = await runInDurableObject(restored, async (db: PouchDatabase) => {
      const bucket = db['env'].BACKUP_BUCKET;
      let reads = 0;
      db['env'].BACKUP_BUCKET = new Proxy(bucket, { get(object, key) {
        if (key === 'get') return async (...args: Parameters<R2Bucket['get']>) => {
          if (String(args[0]).endsWith('.jsonl.gz') && ++reads === m.parts.length + 2) throw new Error('Interrupted import');
          return object.get(...args);
        };
        const value = Reflect.get(object, key); return typeof value === 'function' ? value.bind(object) : value;
      } });
      try { await db.restoreBackup('interrupted', 'vault', m.id); return false; }
      catch {
        const rows = db['ctx'].storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM "by-sequence"').one().n;
        return db['meta']('restore_state') === 'failed' && rows > 0 && rows < m.tables['by-sequence'];
      }
      finally { db['env'].BACKUP_BUCKET = bucket; }
    });
    expect(interrupted).toBe(true);
    expect((await restored.fetch(new Request('https://local/', { headers: { 'x-pouchdb-database': 'interrupted' } }))).status).toBe(503);
    await expect(restored.restoreBackup('interrupted', 'vault', m.id, true)).resolves.toMatchObject({ ok: true });
    expect(await restored.readVaultFile({ path: 'notes/frontmatter.md' })).toMatchObject({ ok: true });
    expect(await restored.getDocument('interrupted', 'partial-11')).toMatchObject({ data: 'x'.repeat(400_000) });
  });

  it('gates HTTP and RPC writers during export and releases on upload failure', async () => {
    const source = await seed();
    const prior = await source.createBackup('vault');
    if (!('id' in prior)) throw new Error('Expected backup');
    const result = await runInDurableObject(source, async (db: PouchDatabase) => {
      const original = db['env'].BACKUP_BUCKET;
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(r => enter = r), released = new Promise<void>(r => release = r);
      db['env'].BACKUP_BUCKET = new Proxy(original, { get(object, key) {
        if (key === 'put') return async () => { enter(); await released; throw new Error('Upload unavailable'); };
        const value = Reflect.get(object, key); return typeof value === 'function' ? value.bind(object) : value;
      } });
      const backup = db.createBackup('vault').catch(() => false);
      await entered;
      const statuses = [];
      for (const path of ['/_bulk_docs', '/_compact', '/_purge', '/']) {
        const response = await db.fetch(new Request(`https://local${path}`, { method: path === '/' ? 'DELETE' : 'POST', headers: { 'x-pouchdb-database': 'vault' }, body: '{}' }));
        statuses.push(response.status);
      }
      const rpc = await db.putDocument('vault', { _id: 'blocked' }).then(() => true, () => false);
      const semantic = await db.createVaultFile({ path: 'blocked.md', content: 'blocked' });
      release(); await backup; db['env'].BACKUP_BUCKET = original;
      return { statuses, rpc, semantic, running: (await db.backupStatus()).running };
    });
    expect(result.statuses).toEqual([503, 503, 503, 503]);
    expect(result.rpc).toBe(false); expect(result.semantic.ok).toBe(false); expect(result.running).toBe(false);
    expect((await listBackups(env.BACKUP_BUCKET, 'vault')).some(m => m.id === prior.id)).toBe(true);
    await verifyBackup(env.BACKUP_BUCKET, prior);
    await expect(source.putDocument('vault', { _id: 'unblocked' })).resolves.toMatchObject({ ok: true });
  });

  it('does not create a missing configured database and honours daily success', async () => {
    const empty = await target();
    expect(await runInDurableObject(empty, async (db: PouchDatabase) => { try { await db.createBackup('vault'); } catch { return 'refused'; } })).toBe('refused');
    expect((await empty.backupStatus()).error).toBeTruthy();
    const source = await seed();
    await source.createBackup('vault');
    expect(await source.createBackup('vault', true)).toEqual({ skipped: true });
  });

  it('recovers completed publication after interruption without another daily backup', async () => {
    const source = await seed(), m = await source.createBackup('vault');
    if (!('id' in m)) throw new Error('Expected backup');
    await runInDurableObject(source, (db: PouchDatabase) => {
      db['setMeta']('backup_status', JSON.stringify({ lastAttempt: m.createdAt, pendingId: m.id }));
    });
    expect(await source.createBackup('vault', true)).toEqual({ skipped: true });
    expect(await source.backupStatus()).toMatchObject({ id: m.id, lastSuccess: m.createdAt });
  });

  it('aborts at the write-pause deadline without publishing a manifest', async () => {
    const source = await seed();
    const state = await runInDurableObject(source, async (db: PouchDatabase) => {
      const bucket = db['env'].BACKUP_BUCKET, now = Date.now;
      const start = now();
      db['env'].BACKUP_BUCKET = new Proxy(bucket, { get(object, key) {
        if (key === 'put') return async (...args: Parameters<R2Bucket['put']>) => {
          const result = await object.put(...args); Date.now = () => start + 60_001; return result;
        };
        const value = Reflect.get(object, key); return typeof value === 'function' ? value.bind(object) : value;
      } });
      try { await db.createBackup('vault'); } catch { /* expected timeout */ }
      finally { Date.now = now; db['env'].BACKUP_BUCKET = bucket; }
      return db.backupStatus();
    });
    expect(state.running).toBe(false); expect(state.lastSuccess).toBeUndefined();
    expect(state.error).toContain('60-second');
    await expect(source.putDocument('vault', { _id: 'after-timeout' })).resolves.toMatchObject({ ok: true });
  });

  it('streams multiple bounded parts and retains conflict leaves across restore', async () => {
    const source = await seed();
    for (let i = 0; i < 12; i++) await source.putDocument('vault', { _id: `large-${i}`, data: 'x'.repeat(400_000) });
    const response = await source.fetch(new Request('https://local/_bulk_docs', { method: 'POST', headers: { 'x-pouchdb-database': 'vault' }, body: JSON.stringify({ new_edits: false, docs: [
      { _id: 'conflict', _rev: '1-aaaa', value: 'left' }, { _id: 'conflict', _rev: '1-bbbb', value: 'right' },
    ] }) }));
    expect(response.status).toBe(201);
    const m = await source.createBackup('vault');
    if (!('id' in m)) throw new Error('Expected backup');
    expect(m.parts.length).toBeGreaterThan(1);
    expect(m.parts.every(p => p.rawBytes <= 4 * 1024 * 1024)).toBe(true);
    const restored = await target(); await restored.restoreBackup('multipart', 'vault', m.id);
    expect(await restored.getDocument('multipart', 'conflict', { conflicts: true })).toMatchObject({ value: 'right', _conflicts: ['1-aaaa'] });
    expect(await restored.getDocument('multipart', 'conflict', { rev: '1-aaaa' })).toMatchObject({ value: 'left' });
    await expectCounts(restored, 'multipart');
    const listing = await listBackups(env.BACKUP_BUCKET, 'vault');
    expect(listing.some(item => item.id === m.id)).toBe(true);
  });

  it('rejects malformed and non-object restore JSON as client errors', async () => {
    for (const body of ['{', 'null', '[]', '"text"', '42', 'true', '{}']) {
      const response = await worker.fetch(new Request('https://local/_backup/restore', {
        method: 'POST', headers: { authorization: `Basic ${btoa('admin:test-password')}`, 'content-type': 'application/json' }, body,
      }), env);
      expect(response.status, body).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'backup_error' });
    }
  });

  it('migrates schema 1 transactionally on open without losing documents', async () => {
    const source = await seed();
    await source.putDocument('vault', { _id: '_design/counts', views: {} });
    const dead = await source.putDocument('vault', { _id: 'dead' });
    await source.putDocument('vault', { _id: 'dead', _rev: dead.rev, _deleted: true });
    const before = await expectCounts(source, 'vault');
    const documents = await runInDurableObject(source, (db: PouchDatabase) => db['database']('vault').allDocs({ include_docs: true }));
    await runInDurableObject(source, async (db: PouchDatabase) => {
      await db['db']!.close(); db['db'] = undefined;
      db['ctx'].storage.transactionSync(() => {
        const sql = db['ctx'].storage.sql;
        sql.exec('ALTER TABLE "metadata-store" DROP COLUMN doc_count');
        sql.exec('UPDATE "metadata-store" SET db_version = 1');
      });
      await db['database']('vault').info();
    });
    expect(await expectCounts(source, 'vault')).toBe(before);
    expect(await runInDurableObject(source, (db: PouchDatabase) => db['database']('vault').allDocs({ include_docs: true }))).toEqual(documents);
    expect(await source.getDocument('vault', '_design/counts')).toMatchObject({ views: {} });
    expect(await source.getDocument('vault', '_local/obsydian_livesync_milestone')).toBeTruthy();
  });

  it('creates an empty schema-2 database and exports its zero count', async () => {
    const source = await target();
    await runInDurableObject(source, (db: PouchDatabase) => { db['env'].BACKUP_DATABASE = 'vault'; });
    await source.ensureDatabase('vault');
    expect(await expectCounts(source, 'vault')).toBe(0);
    const noMilestone = await source.createBackup('vault');
    if (!('id' in noMilestone)) throw new Error('Expected backup');
    const failed = await target();
    expect(await runInDurableObject(failed, async (db: PouchDatabase) => {
      try { await db.restoreBackup('no-milestone', 'vault', noMilestone.id); return false; }
      catch (error) {
        expect((error as Error).message).toContain('no LiveSync milestone');
        return db['db'] === undefined && db['meta']('restore_state') === 'failed';
      }
    })).toBe(true);
    // Restore requires the LiveSync milestone, which is local and does not increase doc_count.
    await source.putDocument('vault', { _id: '_local/obsydian_livesync_milestone' });
    const m = await source.createBackup('vault');
    if (!('id' in m)) throw new Error('Expected backup');
    const restored = await target();
    await restored.restoreBackup('empty', 'vault', m.id);
    expect(await expectCounts(restored, 'empty')).toBe(0);
  });

  it.each(['missing', 'duplicate', 'schema', 'negative', 'fraction', 'unsafe', 'null', 'string', 'mismatch', 'legacy'])(
    'rejects %s metadata safely and permits explicit recovery', async kind => {
      const source = await seed(), m = await source.createBackup('vault');
      if (!('id' in m)) throw new Error('Expected backup');
      const dir = directory('vault', m.id), key = dir + m.parts[0].file;
      const original = new Uint8Array(await (await env.BACKUP_BUCKET.get(key))!.arrayBuffer());
      const rows = unpack(original, m.parts[0]);
      const meta = rows.find(row => row.table === 'metadata-store')!;
      if (kind === 'missing') rows.splice(rows.indexOf(meta), 1);
      else if (kind === 'duplicate') rows.push({ ...meta, values: [...meta.values] });
      else if (kind === 'schema') meta.values[1] = 1;
      else if (kind !== 'legacy') meta.values[2] = ({ negative: -1, fraction: 0.5, unsafe: Number.MAX_SAFE_INTEGER + 1,
        null: null, string: '0', mismatch: 123456 } as Record<string, string | number | null>)[kind];
      const lines = rows.map(row => JSON.stringify(row) + '\n'), bytes = pack(lines);
      const changed = { ...m, tables: { ...m.tables }, parts: [{ ...m.parts[0], bytes: bytes.length,
        rawBytes: Buffer.byteLength(lines.join('')), rows: rows.length, sha256: hash(bytes) }], bytes: bytes.length };
      changed.tables['metadata-store'] = rows.filter(row => row.table === 'metadata-store').length;
      await env.BACKUP_BUCKET.put(key, bytes);
      await env.BACKUP_BUCKET.put(dir + 'manifest.json', JSON.stringify(kind === 'legacy' ? { ...changed, format: 1 } : changed));
      const restored = await target();
      const failure = await runInDurableObject(restored, async (db: PouchDatabase) => {
        try { await db.restoreBackup('invalid', 'vault', m.id); return ''; }
        catch (error) {
          expect(db['db']).toBeUndefined();
          if (kind === 'legacy') expect(db['ctx'].storage.sql.exec("SELECT name FROM sqlite_master WHERE name='document-store'").toArray()).toEqual([]);
          return (error as Error).message;
        }
      });
      expect(failure).toBeTruthy();
      if (kind === 'mismatch') expect(failure).toContain('doc_count mismatch');
      if (kind === 'mismatch') {
        expect(await runInDurableObject(restored, (db: PouchDatabase) => db['ctx'].storage.sql.exec('SELECT doc_count FROM "metadata-store"').one().doc_count)).toBe(123456);
        await evictDurableObject(restored);
      }
      if (kind === 'legacy') {
        expect(failure).toContain('Format-1');
        await expect(listBackups(env.BACKUP_BUCKET, 'vault')).rejects.toThrow('Format-1');
        expect(await env.BACKUP_BUCKET.head(dir + 'manifest.json')).not.toBeNull();
      }
      expect((await restored.fetch(new Request('https://local/', { headers: { 'x-pouchdb-database': 'invalid' } }))).status).toBe(503);
      await expectCounts(source, 'vault');
      await env.BACKUP_BUCKET.put(key, original);
      await env.BACKUP_BUCKET.put(dir + 'manifest.json', JSON.stringify(m));
      await restored.restoreBackup('invalid', 'vault', m.id, true);
      await expectCounts(restored, 'invalid');
    });

  it('requires authentication on every operator route', async () => {
    for (const path of ['/_backup', '/_backup/status', '/_backup/restore']) {
      expect((await worker.fetch(new Request(`https://local${path}`), env)).status).toBe(401);
    }
  });
});
