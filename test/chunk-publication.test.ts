import { env } from 'cloudflare:workers';
import { SELF, runInDurableObject } from 'cloudflare:test';
import PouchDB from 'pouchdb-core';
import HttpPouch from 'pouchdb-adapter-http';
import replication from 'pouchdb-replication';
import { describe, expect, it } from 'vitest';
import type { PouchDatabase } from '../src/pouch-database';

PouchDB.plugin(HttpPouch).plugin(replication);
const replicatingPouch = PouchDB as typeof PouchDB & {
  replicate(
    source: PouchDB.Database<Record<string, unknown>>,
    target: PouchDB.Database<Record<string, unknown>>,
    options: { batch_size: number },
  ): Promise<{ ok: boolean }>;
};

function request(path: string, body?: object) {
  return new Request(`https://chunks.invalid${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-pouchdb-database': 'vault' },
    body: body ? JSON.stringify(body) : undefined,
  });
}
const note = { _id: 'a-text.md', _rev: '1-note', type: 'plain', children: ['h:chunk'], data: '' };
const chunk = { _id: 'h:chunk', _rev: '1-chunk', type: 'leaf', data: 'published content' };

async function setup() {
  const stub = env.POUCH_DATABASES.getByName(`chunk-publication-${crypto.randomUUID()}`);
  await stub.ensureDatabase('vault');
  return stub;
}
async function upload(instance: PouchDatabase, docs: object[]) {
  const response = await instance.fetch(request('/_bulk_docs', { docs, new_edits: false }));
  expect(response.status).toBe(201);
  await response.json();
}
async function readChunk(instance: PouchDatabase) {
  const response = await instance.fetch(request('/_all_docs?include_docs=true', { keys: ['h:chunk'] }));
  expect(response.status).toBe(200);
  return response.json() as Promise<{ rows: { error?: string; doc?: typeof chunk }[] }>;
}
async function changedNote(instance: PouchDatabase, longpoll: boolean, noteId = note._id) {
  const response = await instance.fetch(request(
    `/_changes?style=all_docs&since=0&limit=25${longpoll ? '&feed=longpoll&timeout=1000' : ''}`,
    { selector: { type: { $ne: 'leaf' } } },
  ));
  expect(response.status).toBe(200);
  const body = await response.json() as { results: { id: string }[] };
  expect(body.results.map((row) => row.id)).toEqual([noteId]);
  return readChunk(instance);
}

describe('note and chunk publication', () => {
  it.each([true, false])('checks a concurrent edit during real replication (latest=%s)', async (latest) => {
    const suffix = crypto.randomUUID();
    const nextChunk = { _id: 'h:next-chunk', type: 'leaf', data: 'next content' };
    let edited = false;
    let inspected = false;
    let nextRev = '';
    let originalRev = '';
    const remote = (name: string, fetch: typeof globalThis.fetch) => new PouchDB<Record<string, unknown>>(
      `https://chunks.invalid/${name}-${suffix}`,
      { adapter: 'http', auth: { username: 'admin', password: 'test-password' }, fetch } as PouchDB.Configuration.RemoteDatabaseConfiguration,
    );
    const source = remote('chunk-source', async (input, init) => {
      let req = new Request(input, init);
      const url = new URL(req.url);
      if (url.pathname.endsWith('/_bulk_get') && !edited) {
        edited = true;
        // The replicator has already selected the old note and old chunk.
        // Save the next edit in LiveSync order: chunk first, then metadata.
        expect(url.searchParams.get('latest')).toBe('true');
        await source.put(nextChunk);
        nextRev = (await source.put({
          _id: note._id, _rev: originalRev, type: 'plain', children: [nextChunk._id],
        })).rev;
        // false is a diagnostic control; normal PouchDB requests latest=true.
        url.searchParams.set('latest', String(latest));
        req = new Request(url, req);
      }
      return SELF.fetch(req);
    });
    const target = remote('chunk-target', async (input, init) => {
      const req = new Request(input, init);
      const response = await SELF.fetch(req);
      if (new URL(req.url).pathname.endsWith('/_bulk_docs') && !inspected) {
        inspected = true;
        // Inspect the committed first upload before allowing replication to
        // upload its next batch. No synthetic note-first upload is used.
        const stored = await target.get(note._id);
        expect(stored._rev).toBe(latest ? nextRev : originalRev);
        expect(stored.children).toEqual([latest ? nextChunk._id : chunk._id]);
        const missing = await target.allDocs({ keys: [nextChunk._id], include_docs: true });
        expect(missing.rows[0]).toMatchObject({ error: 'not_found' });
        const available = await target.allDocs({ keys: [chunk._id], include_docs: true });
        expect(available.rows[0]).toMatchObject({ doc: { _id: chunk._id } });
      }
      return response;
    });
    try {
      await source.put({ _id: chunk._id, type: chunk.type, data: chunk.data });
      originalRev = (await source.put({ _id: note._id, type: note.type, children: [chunk._id] })).rev;
      const result = await replicatingPouch.replicate(source, target, { batch_size: 2 });
      expect(result.ok).toBe(true);
      expect(edited).toBe(true);
      expect(inspected).toBe(true);
      // A non-live replication may have already prefetched its empty final
      // changes page before the concurrent edit. The next sync catches up.
      expect((await replicatingPouch.replicate(source, target, { batch_size: 2 })).ok).toBe(true);
      expect(await target.get(note._id)).toMatchObject({ _rev: nextRev, children: [nextChunk._id] });
      expect(await target.get(nextChunk._id)).toMatchObject(nextChunk);
    } finally {
      await source.close();
      await target.close();
    }
  });

  it.each(['note-first', 'chunk-first'] as const)('publishes a complete %s batch to an already waiting long-poll', async (order) => {
    const stub = await setup();
    await runInDurableObject(stub, async (instance: PouchDatabase) => {
      const db = instance['database']();
      await db.id();
      const original = db.changes;
      let registered!: () => void;
      const registration = new Promise<void>((resolve) => { registered = resolve; });
      db.changes = ((options) => {
        const feed = original.call(db, options ?? undefined);
        if (options?.live) registered();
        return feed;
      }) as typeof db.changes;
      try {
        // PouchDB sorts new_edits:false batches by ID, regardless of input
        // order. Choose IDs on either side of h: to exercise both write orders.
        const document = { ...note, _id: order === 'note-first' ? 'a-text.md' : 'z-text.md' };
        const poll = changedNote(instance, true, document._id);
        await registration;
        await upload(instance, [document, chunk]);
        expect((await poll).rows[0].doc).toMatchObject(chunk);
      } finally { db.changes = original; }
    });
  });

  it.each([false, true])('queues chunk lookup safely inside an unfinished batch (longpoll=%s)', async (longpoll) => {
    const stub = await setup();
    await runInDurableObject(stub, async (instance: PouchDatabase) => {
      const db = instance['database']();
      await db.id();
      const sql = instance['ctx'].storage.sql;
      const original = sql.exec;
      let poll: ReturnType<typeof changedNote> | undefined;
      let partial = false;
      sql.exec = ((query: string, ...bindings: SqlStorageValue[]) => {
        const cursor = original.call(sql, query, ...bindings);
        // Run after the note's metadata is visible but before the second
        // document is written. Do not block the transaction or change SQL.
        if (!poll && /(?:INSERT INTO|UPDATE).*document-store/i.test(query)
          && bindings.includes('a-text.md')) {
          const rows = original.call(sql, 'SELECT id FROM "document-store"').toArray();
          partial = rows.some((row) => row.id === 'a-text.md') && !rows.some((row) => row.id === 'h:chunk');
          poll = changedNote(instance, longpoll);
        }
        return cursor;
      }) as SqlStorage['exec'];
      try {
        await upload(instance, [note, chunk]);
        expect(partial).toBe(true);
        expect(poll).toBeDefined();
        expect((await poll!).rows[0].doc).toMatchObject(chunk);
      } finally { sql.exec = original; }
    });
  });

  it('reproduces a temporary missing chunk with separate note-first uploads and then recovers', async () => {
    const stub = await setup();
    await runInDurableObject(stub, async (instance: PouchDatabase) => {
      await upload(instance, [note]);
      expect((await changedNote(instance, true)).rows[0].error).toBe('not_found');
      await upload(instance, [chunk]);
      expect((await readChunk(instance)).rows[0].doc).toMatchObject(chunk);
    });
  });

  it('keeps chunks available with separate chunk-first uploads', async () => {
    const stub = await setup();
    await runInDurableObject(stub, async (instance: PouchDatabase) => {
      await upload(instance, [chunk]);
      await upload(instance, [note]);
      expect((await changedNote(instance, true)).rows[0].doc).toMatchObject(chunk);
    });
  });
});
