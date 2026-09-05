import { env } from 'cloudflare:workers';
import { SELF, reset } from 'cloudflare:test';
import PouchDB from 'pouchdb-core';
import HttpPouch from 'pouchdb-adapter-http';
import find from 'pouchdb-find';
import mapreduce from 'pouchdb-mapreduce';
import replication from 'pouchdb-replication';
import { afterEach, describe, expect, it } from 'vitest';

PouchDB.plugin(HttpPouch).plugin(find).plugin(mapreduce).plugin(replication);

const username = 'admin';
const password = 'test-password';
const authorization = `Basic ${btoa(`${username}:${password}`)}`;
let nextDatabase = 0;

afterEach(async () => {
  await reset();
});

function databaseName(prefix: string): string {
  nextDatabase += 1;
  return `${prefix}-${nextDatabase}`;
}

function workerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return SELF.fetch(new Request(input, init));
}

function remote(name: string): PouchDB.Database<Record<string, unknown>> {
  return new PouchDB(`https://pouch.test/${name}`, {
    adapter: 'http',
    auth: { username, password },
    fetch: workerFetch,
  } as PouchDB.Configuration.RemoteDatabaseConfiguration);
}

async function couchFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', authorization);
  return SELF.fetch(new Request(`https://pouch.test${path}`, { ...init, headers }));
}

describe('CouchDB compatibility surface', () => {
  it('requires credentials and exposes the CouchDB and LiveSync configuration probes', async () => {
    const denied = await SELF.fetch('https://pouch.test/');
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toContain('Basic');

    const root = await couchFetch('/');
    expect(root.status).toBe(200);
    expect(root.headers.get('server')).toContain('CouchDB');
    expect(await root.json()).toMatchObject({ couchdb: 'Welcome' });

    const config = await couchFetch('/_node/_local/_config');
    expect(await config.json()).toMatchObject({
      admins: { admin: '-hashed-' },
      chttpd: { require_valid_user: 'true', enable_cors: 'true' },
      cors: { credentials: 'true' },
    });

    const preflight = await SELF.fetch('https://pouch.test/db/_changes', {
      method: 'OPTIONS',
      headers: {
        origin: 'app://obsidian.md',
        'access-control-request-method': 'POST',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('app://obsidian.md');
  });

  it('supports the PouchDB HTTP document, bulk, changes, and attachment APIs', async () => {
    const db = remote(databaseName('lifecycle'));
    const created = await db.put({
      _id: 'note.md',
      type: 'plain',
      data: 'first',
    });
    expect(created.ok).toBe(true);

    const attachmentPut = await couchFetch(`/lifecycle-${nextDatabase}/note.md/meta.txt?rev=${created.rev}`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'attachment body',
    });
    expect(attachmentPut.status).toBe(201);

    const stored = await db.get('note.md');
    expect(stored.data).toBe('first');
    expect(stored._attachments?.['meta.txt']).toMatchObject({ content_type: 'text/plain', stub: true });
    const attachment = await couchFetch(`/lifecycle-${nextDatabase}/note.md/meta.txt`);
    expect(await attachment.text()).toBe('attachment body');

    const bulk = await db.bulkDocs([
      { _id: 'h:orphan', type: 'leaf', data: 'chunk' },
      { _id: 'parent', type: 'plain', children: ['h:used'] },
      { _id: 'h:used', type: 'leaf', data: 'used chunk' },
    ]);
    expect(bulk).toHaveLength(3);

    const all = await db.allDocs({ include_docs: true, keys: ['note.md', 'parent'] });
    expect(all.rows.map((row) => row.key)).toEqual(['note.md', 'parent']);

    const nonLeaves = await db.changes({ since: 0, include_docs: true, selector: { type: { $ne: 'leaf' } } });
    expect(nonLeaves.results.map((change) => change.id)).toEqual(['note.md', 'parent']);

    const info = await db.info();
    expect(info.doc_count).toBe(4);
    expect(await db.compact()).toMatchObject({ ok: true });
    await db.close();
  });

  it('returns 413 before writes exceed Durable Object SQLite value limits', async () => {
    const name = databaseName('limits');
    const db = remote(name);
    const created = await db.put({ _id: 'attachment-target', type: 'plain' });
    const attachment = await couchFetch(`/${name}/attachment-target/large.bin?rev=${created.rev}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(900_001),
    });
    expect(attachment.status).toBe(413);

    const document = await couchFetch(`/${name}/too-large`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'plain', data: 'x'.repeat(1_800_001) }),
    });
    expect(document.status).toBe(413);
  });

  it('paginates selector-filtered changes without skipping matching rows', async () => {
    const name = databaseName('changes');
    const db = remote(name);
    await db.bulkDocs([
      { _id: 'a', type: 'plain' },
      { _id: 'b', type: 'leaf' },
      { _id: 'c', type: 'plain' },
      { _id: 'd', type: 'plain' },
    ]);

    const first = await couchFetch(`/${name}/_changes?since=0&limit=2&include_docs=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selector: { type: { $ne: 'leaf' } } }),
    });
    const page1 = await first.json() as { results: Array<{ id: string }>; last_seq: number; pending: number };
    expect(page1.results.map((row) => row.id)).toEqual(['a', 'c']);
    expect(page1.pending).toBe(1);

    const second = await couchFetch(`/${name}/_changes?since=${page1.last_seq}&limit=2&include_docs=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selector: { type: { $ne: 'leaf' } } }),
    });
    const page2 = await second.json() as { results: Array<{ id: string }> };
    expect(page2.results.map((row) => row.id)).toEqual(['d']);
  });

  it('supports longpoll and LiveSync fast-fetch continuous change feeds', async () => {
    const name = databaseName('feeds');
    const db = remote(name);
    await db.put({ _id: 'initial', type: 'plain' });

    const longpollPromise = couchFetch(`/${name}/_changes?feed=longpoll&since=now&include_docs=true&timeout=5000`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await db.put({ _id: 'arrived', type: 'plain' });
    const longpoll = await longpollPromise;
    expect((await longpoll.json() as { results: Array<{ id: string }> }).results.map((row) => row.id)).toEqual(['arrived']);

    const continuous = await couchFetch(`/${name}/_changes?feed=continuous&since=0&limit=10&include_docs=true&style=all_docs&conflicts=true&revs=true`);
    const lines = (await continuous.text()).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.slice(0, -1).map((line) => line.id)).toEqual(['initial', 'arrived']);
    expect(lines[0].doc).toMatchObject({ _id: 'initial', _revisions: { start: 1 } });
    expect(lines.at(-1)).toMatchObject({ last_seq: 2, pending: 0 });
  });

  it('replicates between two HTTP databases using PouchDB replication', async () => {
    const source = remote(databaseName('source'));
    const target = remote(databaseName('target'));
    await source.bulkDocs([
      { _id: 'notes/a.md', type: 'plain', data: 'alpha' },
      { _id: 'h:chunk', type: 'leaf', data: 'payload' },
    ]);

    const result = await (PouchDB as typeof PouchDB & {
      replicate(
        source: PouchDB.Database,
        target: PouchDB.Database
      ): Promise<{ ok: boolean; docs_written: number }>;
    }).replicate(source, target);
    expect(result.ok).toBe(true);
    expect(result.docs_written).toBe(2);
    expect((await target.get('notes/a.md')).data).toBe('alpha');
    expect((await target.get('h:chunk')).data).toBe('payload');

    const note = await source.get('notes/a.md');
    await source.remove(note);
    const deletion = await (PouchDB as typeof PouchDB & {
      replicate(
        source: PouchDB.Database,
        target: PouchDB.Database
      ): Promise<{ ok: boolean; docs_written: number }>;
    }).replicate(source, target);
    expect(deletion).toMatchObject({ ok: true, docs_written: 1 });
    await expect(target.get('notes/a.md')).rejects.toMatchObject({ status: 404 });
  });

  it('implements the Mango subset and LiveSync dangling-chunk view and purge', async () => {
    const name = databaseName('livesync');
    const db = remote(name);
    await db.bulkDocs([
      { _id: 'h:orphan', type: 'leaf' },
      { _id: 'h:used', type: 'leaf' },
      { _id: 'parent', type: 'plain', children: ['h:used'] },
    ]);

    const found = await db.find({ selector: { _id: { $gt: 'h:', $lt: 'h:\uffff' }, type: 'leaf' } });
    expect(found.docs.map((doc) => doc._id)).toEqual(['h:orphan', 'h:used']);

    await db.put({
      _id: '_design/chunks',
      ver: 2,
      views: { collectDangling: { map: 'function (doc) { emit([doc._id], 0); }', reduce: '_sum' } },
    });
    const rows = (await (db as PouchDB.Database<Record<string, unknown>> & {
      query(name: string, options: Record<string, unknown>): Promise<{ rows: unknown[] }>;
    }).query('chunks/collectDangling', { reduce: true, group: true })).rows as Array<{
      id: string;
      key: string[];
      value: number;
    }>;
    expect(rows).toContainEqual({ id: 'h:orphan', key: ['h:orphan'], value: 0 });
    expect(rows).toContainEqual({ id: 'h:used', key: ['h:used'], value: 1 });

    const orphan = await db.get('h:orphan');
    const purge = await couchFetch(`/${name}/_purge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 'h:orphan': [orphan._rev] }),
    });
    expect(purge.status).toBe(200);
    await expect(db.get('h:orphan')).rejects.toMatchObject({ status: 404 });
  });

  it('offers typed Durable Object RPC for other Workers', async () => {
    const name = databaseName('rpc');
    const stub = env.POUCH_DATABASES.getByName(name) as unknown as {
      ensureDatabase(name: string): Promise<void>;
      putDocument(name: string, document: Record<string, unknown>): Promise<PouchDB.Core.Response>;
      getDocument(name: string, id: string): Promise<Record<string, unknown>>;
      allDocuments(name: string): Promise<{ rows: Array<{ id: string }> }>;
    };
    await stub.ensureDatabase(name);
    await stub.putDocument(name, { _id: 'from-worker', type: 'plain', data: 'value' });
    expect(await stub.getDocument(name, 'from-worker')).toMatchObject({ data: 'value' });
    expect((await stub.allDocuments(name)).rows.map((row) => row.id)).toEqual(['from-worker']);
  });
});

describe('replication and maintenance regressions', () => {
  it('streams complete and descending feeds and pages sparse matching conflicts without skipping', async () => {
    const name = databaseName('bounded');
    const db = remote(name);
    await db.bulkDocs(Array.from({ length: 130 }, (_, index) => ({ _id: `d${String(index).padStart(3, '0')}`, chosen: index % 17 === 0 })));
    const complete = await (await couchFetch(`/${name}/_changes`)).json() as { results: Array<{ id: string; seq: number }> };
    expect(complete.results).toHaveLength(130);
    const descending = await (await couchFetch(`/${name}/_changes?descending=true`)).json() as typeof complete;
    expect(descending.results.map((row) => row.id)).toEqual(complete.results.map((row) => row.id).reverse());
    let since = 0;
    const seen: string[] = [];
    for (let page = 0; page < 10; page++) {
      const result = await (await couchFetch(`/${name}/_changes?since=${since}&limit=2`, {
        method: 'POST', body: JSON.stringify({ selector: { chosen: true } }),
      })).json() as { results: Array<{ id: string }>; last_seq: number; pending: number };
      seen.push(...result.results.map((row) => row.id)); since = result.last_seq;
      if (!result.pending) break;
    }
    expect(seen).toEqual(Array.from({ length: 8 }, (_, index) => `d${String(index * 17).padStart(3, '0')}`));
    const zero = await (await couchFetch(`/${name}/_changes?limit=0`)).json() as typeof complete;
    expect(zero.results).toHaveLength(1);
    for (const limit of ['-1', '1.5', 'nope', '']) expect((await couchFetch(`/${name}/_changes?limit=${limit}`)).status).toBe(400);
    expect((await couchFetch(`/${name}/_changes`, { method: 'POST', body: JSON.stringify({ selector: { chosen: { $regex: 'x' } } }) })).status).toBe(400);
    await db.bulkDocs([
      { _id: 'conflict', _rev: '1-aaaa', selected: true },
      { _id: 'conflict', _rev: '1-zzzz', selected: false },
    ], { new_edits: false });
    const conflict = await (await couchFetch(`/${name}/_changes?style=all_docs&include_docs=true`, {
      method: 'POST', body: JSON.stringify({ selector: { selected: true } }),
    })).json() as { results: Array<{ changes: Array<{ rev: string }>; doc: { selected: boolean } }> };
    expect(conflict.results).toHaveLength(1);
    expect(conflict.results[0]).toMatchObject({ changes: [{ rev: '1-aaaa' }], doc: { selected: false } });
    expect(await db.get('conflict', { open_revs: 'all' })).toHaveLength(2);
    expect((await couchFetch(`/${name}/conflict?open_revs=nope`)).status).toBe(400);
    await db.close();
  });

  it('protects losing leaves and retained ancestors before allowing chunk cleanup', async () => {
    const name = databaseName('retained');
    const db = remote(name);
    await db.bulkDocs(['left', 'right', 'orphan'].map((key) => ({ _id: `h:${key}`, type: 'leaf', data: key })));
    await db.bulkDocs([
      { _id: 'note.md', _rev: '1-aaaa', path: 'note.md', children: ['h:left'] },
      { _id: 'note.md', _rev: '1-zzzz', path: 'note.md', children: ['h:right'] },
    ], { new_edits: false });
    const view = await (await couchFetch(`/${name}/_design/chunks/_view/collectDangling`)).json() as { rows: Array<{ id: string; value: number }> };
    expect(view.rows.find((row) => row.id === 'h:left')?.value).toBe(1);
    const left = await db.get('h:left'); const orphan = await db.get('h:orphan');
    const purge = (body: object) => couchFetch(`/${name}/_purge`, { method: 'POST', body: JSON.stringify(body) });
    expect((await purge({ 'h:left': [left._rev], 'h:orphan': [orphan._rev] })).status).toBe(409);
    await expect(db.get('h:orphan')).resolves.toBeDefined();
    await db.remove('note.md', '1-aaaa');
    expect((await purge({ 'h:left': [left._rev] })).status).toBe(409);
    await db.compact();
    expect((await purge({ 'h:left': [left._rev] })).status).toBe(200);
    expect((await purge({ 'h:orphan': [orphan._rev] })).status).toBe(200);
    await db.close();
  });
});
