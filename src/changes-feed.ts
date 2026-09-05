import type PouchDB from 'pouchdb-core';
import type { JsonObject } from './types';
import { booleanParam } from './http';
import { matchesSelector, validateSelector } from './selector';

const PAGE = 16;
export function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400, name: 'bad_request' });
}

export function changesLimit(url: URL): number | undefined {
  const value = url.searchParams.get('limit');
  if (value === null) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw badRequest('limit must be a nonnegative integer');
  return Math.max(1, Number(value));
}

export function openRevisions(url: URL): string[] | 'all' | undefined {
  const value = url.searchParams.get('open_revs');
  if (value === null) return undefined;
  if (value === 'all') return 'all';
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((rev) => typeof rev === 'string' && /^\d+-.+/.test(rev))) return parsed;
  } catch { /* Report a protocol error, never an internal JSON parsing error. */ }
  throw badRequest('open_revs must be all or an array of revision IDs');
}

type FeedBody = { selector?: Record<string, unknown>; doc_ids?: string[] };

/** Read-only access to the pinned SQLite adapter's sequence index provides keyset
 * paging in both directions; PouchDB still constructs all revision-tree results.
 * Its public descending changes API ignores since and cannot page backwards. */
export async function* changesFeed(
  db: PouchDB.Database<JsonObject>, sql: SqlStorage, url: URL,
  body: FeedBody, since: number, signal: AbortSignal,
): AsyncGenerator<JsonObject, { last_seq: number; pending: number }> {
  if (body.selector !== undefined) validateSelector(body.selector);
  if (body.doc_ids !== undefined && (!Array.isArray(body.doc_ids) || !body.doc_ids.every((id) => typeof id === 'string'))) {
    throw badRequest('doc_ids must be an array of strings');
  }
  const limit = changesLimit(url) ?? Infinity;
  const descending = booleanParam(url, 'descending') === true;
  const style = url.searchParams.get('style') ?? 'main_only';
  if (style !== 'main_only' && style !== 'all_docs') throw badRequest('Unsupported changes style');
  const target = Number((await db.info()).update_seq);
  let position = descending ? (since > 0 ? since : target + 1) : since;
  let last = since;
  let emitted = 0;
  const wanted = body.doc_ids ? new Set(body.doc_ids) : undefined;
  while (emitted < limit) {
    signal.throwIfAborted();
    const candidates = sql.exec<{ id: string; max_seq: number }>(
      `SELECT id,max_seq FROM "document-store" WHERE max_seq ${descending ? '<' : '>'} ? AND max_seq<=? ORDER BY max_seq ${descending ? 'DESC' : 'ASC'} LIMIT ?`,
      position, target, PAGE,
    ).toArray();
    if (!candidates.length) break;
    const ids = candidates.filter(({ id }) => !wanted || wanted.has(id)).map(({ id }) => id);
    const page = ids.length ? await db.changes({
      since: 0, doc_ids: ids, limit: PAGE, style,
      include_docs: booleanParam(url, 'include_docs') === true || (body.selector !== undefined && style === 'main_only'),
      conflicts: booleanParam(url, 'conflicts'), return_docs: true,
    }) : { results: [] };
    const byId = new Map(page.results.map((row) => [row.id, row]));
    for (const candidate of candidates) {
      if (emitted >= limit) break;
      signal.throwIfAborted();
      position = candidate.max_seq;
      last = position;
      const row = byId.get(candidate.id);
      // A concurrent edit moved this document beyond the captured watermark.
      // Its new sequence belongs to the next replication request.
      if (!row || Number(row.seq) > target) continue;
      if (body.selector) {
        const matching = [];
        for (const leaf of row.changes) {
          const doc = style === 'main_only' ? row.doc : await db.get(row.id, { rev: leaf.rev });
          if (doc && matchesSelector(doc as JsonObject, body.selector)) matching.push(leaf);
        }
        if (!matching.length) continue;
        row.changes = matching;
      }
      const { doc, ...metadata } = row;
      const result: JsonObject = metadata;
      if (booleanParam(url, 'include_docs') === true && doc) {
        result.doc = booleanParam(url, 'revs') || booleanParam(url, 'attachments')
          ? await db.get(row.id, { rev: doc._rev, revs: booleanParam(url, 'revs'),
            attachments: booleanParam(url, 'attachments'), conflicts: booleanParam(url, 'conflicts') })
          : doc;
      }
      emitted++;
      yield result;
    }
  }
  // Unfiltered outstanding document count, not an expensive selector rescan.
  const pending = sql.exec<{ n: number }>(
    `SELECT COUNT(*) AS n FROM "document-store" WHERE max_seq ${descending ? '<' : '>'} ? AND max_seq<=?`,
    position, target,
  ).one().n;
  return { last_seq: last, pending };
}

export function streamChanges(
  iterator: AsyncGenerator<JsonObject, { last_seq: number; pending: number }>,
  first: IteratorResult<JsonObject, { last_seq: number; pending: number }>, continuous: boolean,
): Response {
  const encoder = new TextEncoder();
  let next = first;
  let started = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (next.done) {
          controller.enqueue(encoder.encode(continuous ? `${JSON.stringify(next.value)}\n`
            : `${started ? '' : '{"results":['}],"last_seq":${next.value.last_seq},"pending":${next.value.pending}}`));
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`${continuous ? '' : started ? ',' : '{"results":['}${JSON.stringify(next.value)}${continuous ? '\n' : ''}`));
        started = true;
        next = await iterator.next();
      } catch (error) { controller.error(error); await iterator.return({ last_seq: 0, pending: 0 }); }
    },
    async cancel() { await iterator.return({ last_seq: 0, pending: 0 }); },
  });
  return new Response(stream, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
