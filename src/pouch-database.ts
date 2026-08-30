import { DurableObject } from 'cloudflare:workers';
import PouchDB from 'pouchdb-core';
import cloudflareDOAdapter from 'pouchdb-adapter-cloudflare-do';

import { booleanParam, couchError, json, jsonParam, pouchError, readJson } from './http';
import { matchesSelector } from './selector';
import type { DatabaseInfo, JsonObject } from './types';

PouchDB.plugin(cloudflareDOAdapter);

// Durable Object SQLite rejects a string or BLOB at 2 MB. Leave room for
// PouchDB's revision metadata and JSON serialisation overhead.
const MAX_STORED_VALUE_BYTES = 1_800_000;
const MAX_ATTACHMENT_BYTES = 900_000;

type AnyDatabase = PouchDB.Database<JsonObject> & {
  bulkGet(options: JsonObject): Promise<JsonObject>;
  purge(id: string, rev: string): Promise<JsonObject>;
};

interface ChangesRequest {
  doc_ids?: string[];
  selector?: Record<string, unknown>;
}

interface FindRequest {
  selector?: Record<string, unknown>;
  fields?: string[];
  limit?: number;
  skip?: number;
  sort?: Array<string | Record<string, 'asc' | 'desc'>>;
}

export class PouchDatabase extends DurableObject<Env> {
  private db?: AnyDatabase;
  private dbName?: string;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS cloudflare_pouchdb_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    this.dbName = this.meta('db_name');
  }

  private meta(key: string): string | undefined {
    return this.ctx.storage.sql
      .exec<{ value: string }>('SELECT value FROM cloudflare_pouchdb_meta WHERE key=?', key)
      .toArray()[0]?.value;
  }

  private setMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO cloudflare_pouchdb_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      key,
      value
    );
  }

  private exists(): boolean {
    return this.meta('exists') === 'true';
  }

  private database(name?: string): AnyDatabase {
    if (name && this.dbName && name !== this.dbName) {
      throw Object.assign(new Error('database identity mismatch'), { status: 409, name: 'conflict' });
    }
    if (name && !this.dbName) {
      this.dbName = name;
      this.setMeta('db_name', name);
    }
    if (!this.dbName) {
      throw Object.assign(new Error('database name is required'), { status: 400, name: 'bad_request' });
    }
    if (!this.db) {
      this.db = new PouchDB<JsonObject>(this.dbName, {
        adapter: 'sqlite',
        sqliteImplementation: 'cloudflare-do',
        durableObjectStorage: this.ctx.storage,
      } as PouchDB.Configuration.DatabaseConfiguration) as AnyDatabase;
    }
    return this.db;
  }

  async ensureDatabase(name: string): Promise<void> {
    this.database(name);
    this.setMeta('exists', 'true');
  }

  async getDocument(name: string, id: string, options: PouchDB.Core.GetOptions = {}): Promise<JsonObject> {
    this.requireExists();
    return (await this.database(name).get(id, options)) as JsonObject;
  }

  async putDocument(name: string, document: JsonObject): Promise<PouchDB.Core.Response> {
    this.requireExists();
    ensureDocumentSize(document);
    return this.database(name).put(document);
  }

  async allDocuments(
    name: string,
    options: PouchDB.Core.AllDocsOptions = {}
  ): Promise<PouchDB.Core.AllDocsResponse<JsonObject>> {
    this.requireExists();
    return this.database(name).allDocs(options);
  }

  private requireExists(): void {
    if (!this.exists()) {
      throw Object.assign(new Error('Database does not exist.'), { status: 404, name: 'not_found' });
    }
  }

  async fetch(request: Request): Promise<Response> {
    const name = request.headers.get('x-pouchdb-database');
    if (!name) return couchError(400, 'bad_request', 'database name is required');
    try {
      return await this.route(request, name);
    } catch (error) {
      return pouchError(error);
    }
  }

  private async route(request: Request, name: string): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    if (parts.length === 0) return this.databaseRoute(request, name);
    this.requireExists();
    const db = this.database(name);
    const first = parts[0];

    if (first === '_all_docs') return this.allDocsRoute(request, url, db);
    if (first === '_bulk_docs') return this.bulkDocsRoute(request, db);
    if (first === '_bulk_get') return this.bulkGetRoute(request, url, db);
    if (first === '_revs_diff') return this.revsDiffRoute(request, db);
    if (first === '_changes') return this.changesRoute(request, url, db);
    if (first === '_find') return this.findRoute(request, db);
    if (first === '_index') return this.indexRoute(request);
    if (first === '_compact') return this.compactRoute(request, db);
    if (first === '_ensure_full_commit') return json({ ok: true, instance_start_time: '0' });
    if (first === '_purge') return this.purgeRoute(request, db);
    if (parts[0] === '_design' && parts[2] === '_view') return this.viewRoute(request, parts, db);

    return this.documentRoute(request, url, parts, db);
  }

  private async databaseRoute(request: Request, name: string): Promise<Response> {
    if (request.method === 'PUT') {
      if (this.exists()) return couchError(412, 'file_exists', 'The database could not be created.');
      await this.ensureDatabase(name);
      return json({ ok: true }, { status: 201 });
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (!this.exists()) return couchError(404, 'not_found', 'Database does not exist.');
      const info = await this.database(name).info();
      const size = this.ctx.storage.sql.databaseSize;
      const body: DatabaseInfo = {
        db_name: name,
        doc_count: info.doc_count,
        doc_del_count: 0,
        update_seq: info.update_seq,
        purge_seq: 0,
        compact_running: false,
        disk_format_version: 6,
        instance_start_time: '0',
        sizes: { file: size, external: size, active: size },
      };
      return request.method === 'HEAD' ? new Response(null, { status: 200 }) : json(body);
    }
    if (request.method === 'POST') {
      this.requireExists();
      const document = await readJson<JsonObject>(request);
      ensureDocumentSize(document);
      return json(await this.database(name).post(document), { status: 201 });
    }
    if (request.method === 'DELETE') {
      if (!this.exists()) return couchError(404, 'not_found', 'Database does not exist.');
      await this.database(name).destroy();
      this.db = undefined;
      this.setMeta('exists', 'false');
      return json({ ok: true });
    }
    return couchError(405, 'method_not_allowed', 'Only GET, HEAD, PUT, POST, and DELETE are supported.');
  }

  private async bulkDocsRoute(request: Request, db: AnyDatabase): Promise<Response> {
    if (request.method !== 'POST') return couchError(405, 'method_not_allowed', 'POST required');
    const body = await readJson<{ docs: JsonObject[]; new_edits?: boolean }>(request);
    for (const document of body.docs) ensureDocumentSize(document);
    const result = await db.bulkDocs(body.docs, { new_edits: body.new_edits !== false });
    return json(result, { status: 201 });
  }

  private async allDocsRoute(request: Request, url: URL, db: AnyDatabase): Promise<Response> {
    const body = request.method === 'POST' ? await readJson<{ keys?: string[] }>(request) : {};
    const options = {
      keys: body.keys,
      key: jsonParam(url, 'key'),
      startkey: jsonParam(url, 'startkey'),
      endkey: jsonParam(url, 'endkey'),
      include_docs: booleanParam(url, 'include_docs'),
      attachments: booleanParam(url, 'attachments'),
      conflicts: booleanParam(url, 'conflicts'),
      descending: booleanParam(url, 'descending'),
      inclusive_end: booleanParam(url, 'inclusive_end'),
      update_seq: booleanParam(url, 'update_seq'),
      limit: numberParam(url, 'limit'),
      skip: numberParam(url, 'skip'),
    };
    return json(await db.allDocs(compactUndefined(options) as PouchDB.Core.AllDocsWithKeysOptions));
  }

  private async bulkGetRoute(request: Request, url: URL, db: AnyDatabase): Promise<Response> {
    const body = await readJson<{ docs: Array<{ id: string; rev?: string }> }>(request);
    return json(
      await db.bulkGet({
        docs: body.docs,
        revs: booleanParam(url, 'revs'),
        attachments: booleanParam(url, 'attachments'),
        latest: booleanParam(url, 'latest'),
      })
    );
  }

  private async revsDiffRoute(request: Request, db: AnyDatabase): Promise<Response> {
    const revisions = await readJson<Record<string, string[]>>(request);
    return json(await db.revsDiff(revisions));
  }

  private async changesRoute(request: Request, url: URL, db: AnyDatabase): Promise<Response> {
    const body = request.method === 'POST' ? await readJson<ChangesRequest>(request) : {};
    const sinceValue = url.searchParams.get('since') ?? '0';
    const since = sinceValue === 'now'
      ? (await db.info()).update_seq
      : /^\d+$/.test(sinceValue) ? Number(sinceValue) : sinceValue;
    const limit = numberParam(url, 'limit');
    const selector = body.selector;
    const query = async () => {
      const result = await db.changes({
        since,
        include_docs: true,
        conflicts: booleanParam(url, 'conflicts'),
        attachments: booleanParam(url, 'attachments'),
        binary: false,
        revs: booleanParam(url, 'revs'),
        descending: booleanParam(url, 'descending'),
        style: url.searchParams.get('style') as 'main_only' | 'all_docs' | undefined,
        doc_ids: body.doc_ids,
        return_docs: true,
      } as PouchDB.Core.ChangesOptions);
      if (booleanParam(url, 'revs')) {
        await Promise.all(result.results.map(async (change) => {
          if (!change.doc?._rev) return;
          change.doc = await db.get(change.id, {
            rev: change.doc._rev,
            revs: true,
            conflicts: booleanParam(url, 'conflicts'),
            attachments: booleanParam(url, 'attachments'),
            binary: false,
          });
        }));
      }
      let rows = result.results.filter((change) => {
        return !selector || (!!change.doc && matchesSelector(change.doc as JsonObject, selector));
      });
      const matchingRows = rows.length;
      const hasMore = limit !== undefined && matchingRows > limit;
      if (limit !== undefined) rows = rows.slice(0, limit);
      // A client pages _changes using last_seq. When a response is limited,
      // advancing to the database's final sequence would silently skip rows.
      const lastSeq = hasMore && rows.length > 0 ? rows[rows.length - 1].seq : result.last_seq;
      if (booleanParam(url, 'include_docs') !== true) {
        rows = rows.map(({ doc: _doc, ...change }) => change) as typeof rows;
      }
      return { results: rows, last_seq: lastSeq, pending: Math.max(0, matchingRows - rows.length) };
    };

    let result = await query();
    if (url.searchParams.get('feed') === 'longpoll' && result.results.length === 0) {
      const timeout = Math.min(numberParam(url, 'timeout') ?? 25_000, 55_000);
      await waitForChange(db, since, timeout);
      result = await query();
    }
    if (url.searchParams.get('feed') === 'continuous') {
      const lines = [
        ...result.results.map((change) => JSON.stringify(change)),
        JSON.stringify({ last_seq: result.last_seq, pending: result.pending }),
      ];
      return new Response(`${lines.join('\n')}\n`, {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
    return json(result);
  }

  private async findRoute(request: Request, db: AnyDatabase): Promise<Response> {
    const body = await readJson<FindRequest>(request);
    const all = await db.allDocs({ include_docs: true });
    let docs = all.rows
      .map((row) => row.doc as JsonObject | undefined)
      .filter((doc): doc is JsonObject => !!doc && !String(doc._id).startsWith('_design/'))
      .filter((doc) => matchesSelector(doc, body.selector ?? {}));
    docs = sortDocuments(docs, body.sort);
    docs = docs.slice(body.skip ?? 0, body.limit === undefined ? undefined : (body.skip ?? 0) + body.limit);
    if (body.fields) docs = docs.map((doc) => Object.fromEntries(body.fields!.map((key) => [key, doc[key]])));
    return json({ docs, bookmark: 'nil' });
  }

  private async indexRoute(request: Request): Promise<Response> {
    if (request.method === 'GET') {
      return json({ total_rows: 1, indexes: [{ ddoc: null, name: '_all_docs', type: 'special', def: { fields: [{ _id: 'asc' }] } }] });
    }
    if (request.method === 'POST') return json({ result: 'created', id: '_design/cloudflare', name: 'cloudflare' });
    return couchError(405, 'method_not_allowed', 'GET or POST required');
  }

  private async compactRoute(request: Request, db: AnyDatabase): Promise<Response> {
    if (request.method !== 'POST') return couchError(405, 'method_not_allowed', 'POST required');
    await db.compact();
    return json({ ok: true }, { status: 202 });
  }

  private async purgeRoute(request: Request, db: AnyDatabase): Promise<Response> {
    const requested = await readJson<Record<string, string[]>>(request);
    const purged: Record<string, string[]> = {};
    for (const [id, revisions] of Object.entries(requested)) {
      for (const revision of revisions) await db.purge(id, revision);
      purged[id] = revisions;
    }
    return json({ purge_seq: null, purged });
  }

  private async viewRoute(request: Request, parts: string[], db: AnyDatabase): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'POST') {
      return couchError(405, 'method_not_allowed', 'GET or POST required');
    }
    if (parts[1] !== 'chunks' || parts[3] !== 'collectDangling') {
      return couchError(404, 'not_found', 'missing_named_view');
    }
    const all = await db.allDocs({ include_docs: true });
    const totals = new Map<string, number>();
    for (const row of all.rows) {
      const doc = row.doc as JsonObject | undefined;
      if (!doc) continue;
      if (String(doc._id).startsWith('h:')) {
        totals.set(String(doc._id), totals.get(String(doc._id)) ?? 0);
      } else if (Array.isArray(doc.children)) {
        for (const child of doc.children) totals.set(String(child), (totals.get(String(child)) ?? 0) + 1);
      }
    }
    return json({ total_rows: totals.size, offset: 0, rows: [...totals].sort().map(([id, value]) => ({ id, key: [id], value })) });
  }

  private async documentRoute(request: Request, url: URL, parts: string[], db: AnyDatabase): Promise<Response> {
    const special = parts[0] === '_design' || parts[0] === '_local';
    const id = special ? `${parts[0]}/${parts[1]}` : parts[0];
    const attachment = parts.slice(special ? 2 : 1).join('/');
    if (attachment) return this.attachmentRoute(request, url, db, id, attachment);

    if (request.method === 'GET') {
      const options = compactUndefined({
        rev: url.searchParams.get('rev') ?? undefined,
        revs: booleanParam(url, 'revs'),
        revs_info: booleanParam(url, 'revs_info'),
        latest: booleanParam(url, 'latest'),
        conflicts: booleanParam(url, 'conflicts'),
        attachments: booleanParam(url, 'attachments'),
        binary: false,
        open_revs: jsonParam<string[] | 'all'>(url, 'open_revs'),
      });
      if (options.open_revs) return json(await db.get(id, options as PouchDB.Core.GetOptions));
      return json(await db.get(id, options));
    }
    if (request.method === 'PUT') {
      const doc = await readJson<JsonObject>(request);
      doc._id = id;
      ensureDocumentSize(doc);
      return json(await db.put(doc), { status: 201 });
    }
    if (request.method === 'DELETE') {
      const rev = url.searchParams.get('rev');
      if (!rev) return couchError(400, 'bad_request', 'Document revision is required.');
      return json(await db.remove(id, rev));
    }
    return couchError(405, 'method_not_allowed', 'GET, PUT, or DELETE required');
  }

  private async attachmentRoute(request: Request, url: URL, db: AnyDatabase, id: string, attachment: string): Promise<Response> {
    const rev = url.searchParams.get('rev') ?? undefined;
    if (request.method === 'GET') {
      const doc = await db.get(id);
      const metadata = (doc._attachments as Record<string, { content_type?: string }> | undefined)?.[attachment];
      const data = await db.getAttachment(id, attachment, { rev });
      return new Response(data as BodyInit, { headers: { 'content-type': metadata?.content_type ?? 'application/octet-stream' } });
    }
    if (request.method === 'PUT') {
      // workerd exposes Blob but not FileReader. Passing a Blob to PouchDB's
      // browser binary helper therefore fails; its base64 input path is fully
      // portable and is also the CouchDB wire representation.
      const buffer = await request.arrayBuffer();
      if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
        return couchError(413, 'too_large', 'Attachment exceeds the Durable Object SQLite value limit.');
      }
      const data = arrayBufferToBase64(buffer);
      const type = request.headers.get('content-type') ?? 'application/octet-stream';
      const result = rev
        ? await db.putAttachment(id, attachment, rev, data as unknown as Blob, type)
        : await db.putAttachment(id, attachment, data as unknown as Blob, type);
      return json(result, { status: 201 });
    }
    if (request.method === 'DELETE' && rev) return json(await db.removeAttachment(id, attachment, rev));
    return couchError(400, 'bad_request', 'Attachment revision is required.');
  }
}

function numberParam(url: URL, key: string): number | undefined {
  const value = url.searchParams.get(key);
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compactUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 32_768;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function ensureDocumentSize(document: JsonObject): void {
  const bytes = new TextEncoder().encode(JSON.stringify(document)).byteLength;
  if (bytes > MAX_STORED_VALUE_BYTES) {
    throw Object.assign(
      new Error('Document exceeds the Durable Object SQLite value limit.'),
      { status: 413, name: 'too_large' }
    );
  }
  const attachments = document._attachments;
  if (typeof attachments === 'object' && attachments !== null) {
    for (const attachment of Object.values(attachments as Record<string, unknown>)) {
      if (typeof attachment !== 'object' || attachment === null) continue;
      const data = (attachment as { data?: unknown }).data;
      if (typeof data === 'string' && Math.floor(data.length * 3 / 4) > MAX_ATTACHMENT_BYTES) {
        throw Object.assign(
          new Error('Attachment exceeds the Durable Object SQLite value limit.'),
          { status: 413, name: 'too_large' }
        );
      }
    }
  }
}

async function waitForChange(db: AnyDatabase, since: string | number, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const feed = db.changes({ since, live: true, return_docs: false });
    const timer = setTimeout(() => {
      feed.cancel();
      resolve();
    }, timeoutMs);
    feed.once('change', () => {
      clearTimeout(timer);
      feed.cancel();
      resolve();
    });
    feed.once('error', (error: unknown) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function sortDocuments(docs: JsonObject[], sort: FindRequest['sort']): JsonObject[] {
  if (!sort?.length) return docs;
  return [...docs].sort((left, right) => {
    for (const entry of sort) {
      const [field, direction] = typeof entry === 'string' ? [entry, 'asc'] : Object.entries(entry)[0];
      if (left[field] === right[field]) continue;
      const result = (left[field] as never) < (right[field] as never) ? -1 : 1;
      return direction === 'desc' ? -result : result;
    }
    return 0;
  });
}
