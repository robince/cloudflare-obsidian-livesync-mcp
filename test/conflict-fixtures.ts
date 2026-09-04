import { env } from 'cloudflare:workers';
import { expect } from 'vitest';
import fixture from './fixtures/livesync-1.0.21.json';
import type { JsonObject } from '../src/types';

export async function conflictVault(options: {
  path?: string; base?: string; leaves?: string[]; deleted?: number;
  binary?: boolean; unrelated?: boolean; missingBase?: boolean; missingChunk?: number;
} = {}) {
  const name = `conflict-${crypto.randomUUID().replaceAll('-', '')}`;
  const stub = env.POUCH_DATABASES.getByName(name);
  await stub.ensureDatabase(name);
  for (const document of Object.values(fixture.localDocuments)) {
    const copy = structuredClone(document) as JsonObject;
    delete copy._rev;
    await stub.putDocument(name, copy);
  }
  const path = options.path ?? 'notes/conflict.md';
  const texts = options.leaves ?? ['A\nbase\nend\n', 'start\nbase\nB\n'];
  const note = (content: string, rev: string, index: number): JsonObject => ({
    _id: path, _rev: rev, path, type: options.binary ? 'newnote' : 'plain',
    datatype: options.binary ? 'newnote' : 'plain', ctime: 1000, mtime: (index + 2) * 1000,
    size: content.length, children: [`h:conflict-${index}`], eden: {},
    ...(options.deleted === index ? { deleted: true } : {}),
  });
  const base = note(options.base ?? 'start\nbase\nend\n', '1-base', -1);
  const docs: JsonObject[] = [];
  for (const [index, content] of [options.base ?? 'start\nbase\nend\n', ...texts].entries()) {
    if (options.missingChunk === index - 1) continue;
    await stub.putDocument(name, { _id: `h:conflict-${index - 1}`, type: 'leaf', data: content });
  }
  if (!options.missingBase) docs.push(base);
  const leaves = texts.map((text, index) => ({
    ...note(text, `2-${String.fromCharCode(97 + index)}`, index),
    _revisions: { start: 2, ids: [String.fromCharCode(97 + index), options.unrelated ? `root${index}` : 'base'] },
  }));
  docs.push(...leaves);
  const response = await stub.fetch(new Request('https://test/_bulk_docs', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-pouchdb-database': name },
    body: JSON.stringify({ docs, new_edits: false }),
  }));
  expect(response.status).toBe(201);
  const tree = async () => {
    const winner = await stub.getDocument(name, path, { conflicts: true, revs_info: true }) as JsonObject;
    const revs = [winner._rev as string, ...((winner._conflicts ?? []) as string[])].sort();
    return Promise.all(revs.map(async rev => await stub.getDocument(name, path, { rev, revs_info: true }) as JsonObject));
  };
  return { name, stub, path, tree };
}
