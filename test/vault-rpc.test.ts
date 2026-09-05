import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import type PouchDB from 'pouchdb-core';
import { describe, expect, it } from 'vitest';
import xxhashNew from 'xxhash-wasm-102';

import fixture from './fixtures/livesync-1.0.21.json';
import { CommonlibFacade } from '../src/livesync-vault/commonlib';
import type { PouchDatabase } from '../src/pouch-database';
import type { JsonObject } from '../src/types';

function databaseName(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replaceAll('-', '')}`;
}

function withoutRevision(document: JsonObject): JsonObject {
  const copy = structuredClone(document);
  delete copy._rev;
  delete copy._revisions;
  delete copy._revs_info;
  delete copy._conflicts;
  return copy;
}

async function seededVault(prefix = 'vault-rpc') {
  const name = databaseName(prefix);
  const stub = env.POUCH_DATABASES.getByName(name);
  await stub.ensureDatabase(name);
  for (const document of fixture.documents) {
    await stub.putDocument(name, withoutRevision(document as JsonObject));
  }
  for (const document of Object.values(fixture.localDocuments)) {
    await stub.putDocument(name, withoutRevision(document as JsonObject));
  }
  return { name, stub };
}

describe('vault RPC', () => {
  it('reports the current fixture profile', async () => {
    const { stub } = await seededVault();
    const status = await stub.vaultStatus();

    expect(status).toEqual({
      ok: true,
      data: { contractVersion: 5, compatible: true, reasons: [] },
    });
  });

  it('lists Markdown files with a prefix-bound best-effort cursor', async () => {
    const { stub } = await seededVault();
    const first = await stub.listVaultFiles({ prefix: 'notes/', limit: 2 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.files).toHaveLength(2);
    expect(first.data.files.every((file) => file.path.startsWith('notes/'))).toBe(true);
    expect(first.data.files.every((file) => typeof file.sizeBytes === 'number')).toBe(true);
    expect(first.data.files.every((file) => typeof file.createdAt === 'number')).toBe(true);
    expect(first.data.files.every((file) => typeof file.modifiedAt === 'number')).toBe(true);
    expect(first.data.cursor).toEqual(expect.any(String));

    const second = await stub.listVaultFiles({ prefix: 'notes/', cursor: first.data.cursor });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const listed = [...first.data.files, ...second.data.files].map((file) => file.path).sort();
    expect(listed).toEqual(Object.keys(fixture.files).sort());

    const mismatched = await stub.listVaultFiles({ prefix: '', cursor: first.data.cursor });
    expect(mismatched).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });

  it('builds and reuses a derived Unicode FTS index with literal path scoping', async () => {
    const { stub } = await seededVault('search');
    const first = await stub.searchVaultFiles({ query: 'naive', pathPrefix: 'notes/' });
    expect(first).toMatchObject({
      ok: true,
      data: {
        results: [expect.objectContaining({ path: 'notes/unicode-雪.md', snippet: expect.stringContaining('⟦') })],
        truncated: false,
        incomplete: false,
        unindexedFiles: 0,
      },
    });
    const before = await runInDurableObject(stub, (instance: PouchDatabase) => ({
      checkpoint: instance['ctx'].storage.sql
        .exec<{ value: string }>("SELECT value FROM livesync_search_meta WHERE key='checkpoint'").one().value,
      rows: instance['ctx'].storage.sql
        .exec<{ count: number }>('SELECT COUNT(*) AS count FROM livesync_search_fts').one().count,
    }));
    await expect(stub.searchVaultFiles({ query: 'MCP fixture', pathPrefix: 'notes/' })).resolves.toMatchObject({
      ok: true,
      data: { results: [expect.objectContaining({ path: 'notes/frontmatter.md' })] },
    });
    await expect(stub.searchVaultFiles({ query: 'MCP fixture', pathPrefix: 'other/' })).resolves.toMatchObject({
      ok: true,
      data: { results: [] },
    });
    await expect(stub.searchVaultFiles({ query: '" OR *' })).resolves.toMatchObject({ ok: true });
    const after = await runInDurableObject(stub, (instance: PouchDatabase) => ({
      checkpoint: instance['ctx'].storage.sql
        .exec<{ value: string }>("SELECT value FROM livesync_search_meta WHERE key='checkpoint'").one().value,
      rows: instance['ctx'].storage.sql
        .exec<{ count: number }>('SELECT COUNT(*) AS count FROM livesync_search_fts').one().count,
    }));
    expect(after).toEqual(before);
  });

  it('weights path and title above body and breaks equal BM25 scores by path', async () => {
    const { stub } = await seededVault('search-ranking');
    await stub.createVaultFile({ path: 'notes/needle.md', content: 'unrelated body\n' });
    await stub.createVaultFile({ path: 'notes/body-only.md', content: 'needle\n' });
    await stub.createVaultFile({ path: 'notes/tie-b.md', content: 'equalrank\n' });
    await stub.createVaultFile({ path: 'notes/tie-a.md', content: 'equalrank\n' });
    await stub.createVaultFile({ path: 'notes/100%_literal.md', content: 'prefixmarker\n' });
    await stub.createVaultFile({ path: 'Notes/case-prefix.md', content: 'caseprefixmarker\n' });

    const weighted = await stub.searchVaultFiles({ query: 'needle' });
    expect(weighted).toMatchObject({ ok: true });
    if (weighted.ok) expect(weighted.data.results.map(({ path }) => path).slice(0, 2)).toEqual([
      'notes/needle.md',
      'notes/body-only.md',
    ]);
    const tied = await stub.searchVaultFiles({ query: 'equalrank' });
    expect(tied).toMatchObject({ ok: true });
    if (tied.ok) expect(tied.data.results.map(({ path }) => path)).toEqual(['notes/tie-a.md', 'notes/tie-b.md']);
    await expect(stub.searchVaultFiles({ query: 'prefixmarker', pathPrefix: 'notes/100%_' })).resolves.toMatchObject({
      ok: true, data: { results: [expect.objectContaining({ path: 'notes/100%_literal.md' })] },
    });
    await expect(stub.searchVaultFiles({ query: 'caseprefixmarker', pathPrefix: 'notes/' })).resolves.toMatchObject({
      ok: true, data: { results: [expect.objectContaining({ path: 'Notes/case-prefix.md' })] },
    });
  });

  it('waits for late chunks and excludes oversized or malformed winners without partial search', async () => {
    const { name, stub } = await seededVault('search-repair');
    await stub.putDocument(name, {
      _id: 'notes/late.md', path: 'notes/late.md', type: 'plain', datatype: 'plain',
      children: ['h:late-search'], size: 10, ctime: 1, mtime: 1, eden: {},
    });
    await expect(stub.searchVaultFiles({ query: 'replicated' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
    const pending = await runInDurableObject(stub, (instance: PouchDatabase) => ({
      rows: instance['ctx'].storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM livesync_search_documents WHERE path='notes/late.md'").one().count,
      checkpoint: Number(instance['ctx'].storage.sql
        .exec<{ value: string }>("SELECT value FROM livesync_search_meta WHERE key='checkpoint'").one().value),
    }));
    expect(pending.rows).toBe(0);

    await stub.putDocument(name, { _id: 'h:late-search', type: 'leaf', data: 'fully replicated content' });
    await expect(stub.searchVaultFiles({ query: 'replicated' })).resolves.toMatchObject({
      ok: true,
      data: { results: [expect.objectContaining({ path: 'notes/late.md' })] },
    });

    await stub.putDocument(name, { _id: 'h:oversized-search-1', type: 'leaf', data: 'x'.repeat(300_000) });
    await stub.putDocument(name, { _id: 'h:oversized-search-2', type: 'leaf', data: 'y'.repeat(300_000) });
    await stub.putDocument(name, {
      _id: 'notes/oversized-search.md', path: 'notes/oversized-search.md', type: 'plain', datatype: 'plain',
      children: ['h:oversized-search-1', 'h:oversized-search-2'], size: 600_000, ctime: 1, mtime: 1, eden: {},
    });
    await stub.putDocument(name, {
      _id: 'notes/malformed-search.md', path: 'notes/malformed-search.md', type: 'plain', datatype: 'plain',
      children: 'not-an-array', size: 1, ctime: 1, mtime: 1, eden: {},
    });
    await stub.putDocument(name, {
      _id: 'notes/too-many-chunks.md', path: 'notes/too-many-chunks.md', type: 'plain', datatype: 'plain',
      children: Array.from({ length: 1_025 }, (_, index) => `h:absent-${index}`),
      size: 0, ctime: 1, mtime: 1, eden: {},
    });
    await expect(stub.searchVaultFiles({ query: 'replicated' })).resolves.toMatchObject({
      ok: true,
      data: { incomplete: true, unindexedFiles: 3 },
    });
    const repairedCheckpoint = await runInDurableObject(stub, (instance: PouchDatabase) => Number(
      instance['ctx'].storage.sql
        .exec<{ value: string }>("SELECT value FROM livesync_search_meta WHERE key='checkpoint'").one().value,
    ));
    expect(repairedCheckpoint).toBeGreaterThan(pending.checkpoint);
  });

  it('updates and removes indexed MCP winners and rebuilds disposable search schema', async () => {
    const { stub } = await seededVault('search-lifecycle');
    const created = await stub.createVaultFile({ path: 'notes/search-lifecycle.md', content: 'old searchable phrase\n' });
    expect(created.ok).toBe(true);
    await expect(stub.searchVaultFiles({ query: 'old searchable' })).resolves.toMatchObject({
      ok: true, data: { results: [expect.objectContaining({ path: 'notes/search-lifecycle.md' })] },
    });
    if (!created.ok) return;
    const updated = await stub.updateVaultFile({
      path: 'notes/search-lifecycle.md', content: 'new searchable phrase\n', expectedRevision: created.data.revision,
    });
    expect(updated.ok).toBe(true);
    await expect(stub.searchVaultFiles({ query: 'old' })).resolves.toMatchObject({ ok: true, data: { results: [] } });
    await expect(stub.searchVaultFiles({ query: 'new' })).resolves.toMatchObject({
      ok: true, data: { results: [expect.objectContaining({ path: 'notes/search-lifecycle.md' })] },
    });

    await runInDurableObject(stub, (instance: PouchDatabase) => {
      instance['ctx'].storage.sql.exec("UPDATE livesync_search_meta SET value='obsolete' WHERE key='schema_version'");
    });
    await expect(stub.searchVaultFiles({ query: 'new' })).resolves.toMatchObject({
      ok: true, data: { results: [expect.objectContaining({ path: 'notes/search-lifecycle.md' })] },
    });
    if (!updated.ok) return;
    await stub.deleteVaultFile({ path: 'notes/search-lifecycle.md', expectedRevision: updated.data.revision });
    await expect(stub.searchVaultFiles({ query: 'new' })).resolves.toMatchObject({ ok: true, data: { results: [] } });
  });

  it('refreshes conflict counts without changing or retokenising an unchanged winner', async () => {
    const { name, stub } = await seededVault('search-conflict-count');
    const path = 'notes/search-conflict-count.md';
    const created = await stub.createVaultFile({ path, content: 'winning searchable content\n' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const first = await stub.searchVaultFiles({ query: 'winning' });
    expect(first).toMatchObject({
      ok: true, data: { results: [expect.objectContaining({ path, revision: created.data.revision })] },
    });
    await stub.putDocument(name, { _id: 'h:losing-search-conflict', type: 'leaf', data: 'losing branch content\n' });
    const conflict = await stub.fetch(new Request('https://test/_bulk_docs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pouchdb-database': name },
      body: JSON.stringify({
        new_edits: false,
        docs: [{
          _id: path,
          _rev: '1-00000000000000000000000000000000',
          _revisions: { start: 1, ids: ['00000000000000000000000000000000'] },
          path,
          type: 'plain',
          datatype: 'plain',
          children: ['h:losing-search-conflict'],
          size: 22,
          ctime: 1,
          mtime: 1,
          eden: {},
        }],
      }),
    }));
    expect(conflict.status).toBe(201);
    const treeBefore = await stub.getDocument(name, path, { conflicts: true }) as unknown as JsonObject;
    expect(treeBefore._rev).toBe(created.data.revision);
    await expect(stub.searchVaultFiles({ query: 'winning' })).resolves.toMatchObject({
      ok: true,
      data: { results: [expect.objectContaining({ path, revision: created.data.revision, unresolvedVersions: 2 })] },
    });
    await expect(stub.searchVaultFiles({ query: 'losing' })).resolves.toMatchObject({ ok: true, data: { results: [] } });
    await expect(stub.getDocument(name, path, { conflicts: true })).resolves.toEqual(treeBefore);
  });

  it('indexes raw CouchDB bulk updates and removes CouchDB tombstones', async () => {
    const { name, stub } = await seededVault('search-bulk-docs');
    const path = 'notes/frontmatter.md';
    await stub.searchVaultFiles({ query: 'MCP fixture' });
    await stub.putDocument(name, { _id: 'h:raw-search-update', type: 'leaf', data: 'raw replicated winner\n' });
    const current = await stub.getDocument(name, path) as unknown as JsonObject;
    const headers = { 'content-type': 'application/json', 'x-pouchdb-database': name };
    const update = await stub.fetch(new Request('https://test/_bulk_docs', {
      method: 'POST',
      headers,
      body: JSON.stringify({ docs: [{
        ...current,
        children: ['h:raw-search-update'],
        size: 22,
        mtime: 2,
      }] }),
    }));
    expect(update.status).toBe(201);
    await expect(stub.searchVaultFiles({ query: 'replicated winner' })).resolves.toMatchObject({
      ok: true, data: { results: [expect.objectContaining({ path })] },
    });

    const updated = await stub.getDocument(name, path) as unknown as JsonObject;
    const removed = await stub.fetch(new Request('https://test/_bulk_docs', {
      method: 'POST',
      headers,
      body: JSON.stringify({ docs: [{ _id: path, _rev: updated._rev, _deleted: true }] }),
    }));
    expect(removed.status).toBe(201);
    await expect(stub.searchVaultFiles({ query: 'replicated winner' })).resolves.toMatchObject({
      ok: true, data: { results: [] },
    });
  });

  it('removes a stale row when a raw winner stops being metadata', async () => {
    const { name, stub } = await seededVault('search-invalid-path');
    const path = 'notes/frontmatter.md';
    await expect(stub.searchVaultFiles({ query: 'MCP fixture' })).resolves.toMatchObject({
      ok: true, data: { results: [expect.objectContaining({ path })] },
    });
    const current = await stub.getDocument(name, path) as unknown as JsonObject;
    delete current.path;
    await stub.putDocument(name, current);
    await expect(stub.searchVaultFiles({ query: 'MCP fixture' })).resolves.toMatchObject({
      ok: true, data: { results: [] },
    });
  });

  it('retries when _changes coalesces a document beyond the captured watermark', async () => {
    const { name, stub } = await seededVault('search-watermark-race');
    const path = 'notes/frontmatter.md';
    await stub.searchVaultFiles({ query: 'MCP fixture' });
    const beforeTarget = await stub.getDocument(name, path) as unknown as JsonObject;
    beforeTarget.mtime = 2;
    await stub.putDocument(name, beforeTarget);

    const raced = await runInDurableObject(stub, async (instance: PouchDatabase) => {
      const db = instance['database']();
      const originalChanges = db.changes.bind(db);
      let injected = false;
      db.changes = ((options: PouchDB.Core.ChangesOptions) => {
        if (injected) return originalChanges(options);
        injected = true;
        return (async () => {
          const afterTarget = await db.get(path) as unknown as JsonObject;
          afterTarget.mtime = 3;
          await db.put(afterTarget);
          return await originalChanges(options);
        })();
      }) as typeof db.changes;
      try {
        return await instance.searchVaultFiles({ query: 'MCP fixture' });
      } finally {
        db.changes = originalChanges as typeof db.changes;
      }
    });
    expect(raced).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    await expect(stub.searchVaultFiles({ query: 'MCP fixture' })).resolves.toMatchObject({
      ok: true, data: { results: [expect.objectContaining({ path })] },
    });
  });

  it('serializes concurrent search reconciliation within one vault', async () => {
    const { stub } = await seededVault('search-serialization');
    const maximumActive = await runInDurableObject(stub, async (instance: PouchDatabase) => {
      const originalSearch = instance['search'].bind(instance);
      let releaseFirst!: () => void;
      const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let calls = 0;
      let active = 0;
      let maximum = 0;
      instance['search'] = (() => ({
        search: async () => {
          calls += 1;
          active += 1;
          maximum = Math.max(maximum, active);
          if (calls === 1) await firstMayFinish;
          active -= 1;
          return { ok: true, data: { results: [], truncated: false, incomplete: false, unindexedFiles: 0 } };
        },
      })) as unknown as typeof instance['search'];
      try {
        const first = instance.searchVaultFiles({ query: 'first' });
        await Promise.resolve();
        const second = instance.searchVaultFiles({ query: 'second' });
        await Promise.resolve();
        releaseFirst();
        await Promise.all([first, second]);
        return maximum;
      } finally {
        instance['search'] = originalSearch;
      }
    });
    expect(maximumActive).toBe(1);
  });

  it('bounds search results and snippets and preserves progress at the catch-up deadline', async () => {
    const { stub } = await seededVault('search-bounds');
    const token = 'z'.repeat(200);
    for (let index = 0; index < 3; index += 1) {
      await stub.createVaultFile({
        path: `notes/bounded-${index}.md`,
        content: `${token} `.repeat(30),
      });
    }
    const timedOut = await runInDurableObject(stub, async (instance: PouchDatabase) => {
      const originalNow = Date.now;
      let calls = 0;
      Date.now = () => calls++ < 10 ? 0 : 3_000;
      try {
        const result = await instance.searchVaultFiles({ query: token, limit: 2 });
        const checkpoint = Number(instance['ctx'].storage.sql
          .exec<{ value: string }>("SELECT value FROM livesync_search_meta WHERE key='checkpoint'").one().value);
        const target = Number((await instance['database']().info()).update_seq);
        return { result, checkpoint, target };
      } finally {
        Date.now = originalNow;
      }
    });
    expect(timedOut.result).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(timedOut.checkpoint).toBeGreaterThan(0);
    expect(timedOut.checkpoint).toBeLessThan(timedOut.target);

    const result = await stub.searchVaultFiles({ query: token, limit: 2 });
    expect(result).toMatchObject({
      ok: true,
      data: { results: [{}, {}], truncated: true },
    });
    if (!result.ok) return;
    expect(result.data.results.every(
      ({ snippet }) => new TextEncoder().encode(snippet).byteLength <= 1_024,
    )).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(result.data)).byteLength).toBeLessThanOrEqual(128 * 1_024);
  });

  it('survives compaction, invalidates on purge, and clears stale rows after database recreation', async () => {
    const { name, stub } = await seededVault('search-database-lifecycle');
    await expect(stub.searchVaultFiles({ query: 'naive' })).resolves.toMatchObject({
      ok: true, data: { results: [expect.objectContaining({ path: 'notes/unicode-雪.md' })] },
    });
    const headers = { 'content-type': 'application/json', 'x-pouchdb-database': name };
    const compact = await stub.fetch(new Request('https://test/_compact', { method: 'POST', headers }));
    expect(compact.status).toBe(202);
    await expect(stub.searchVaultFiles({ query: 'naive' })).resolves.toMatchObject({
      ok: true, data: { results: [expect.objectContaining({ path: 'notes/unicode-雪.md' })] },
    });

    const current = await stub.getDocument(name, 'notes/unicode-雪.md') as unknown as JsonObject;
    const purge = await stub.fetch(new Request('https://test/_purge', {
      method: 'POST', headers, body: JSON.stringify({ 'notes/unicode-雪.md': [current._rev] }),
    }));
    expect(purge.status).toBe(200);
    await expect(stub.searchVaultFiles({ query: 'naive' })).resolves.toMatchObject({
      ok: true, data: { results: [] },
    });

    const removed = await stub.fetch(new Request('https://test/', { method: 'DELETE', headers }));
    expect(removed.status).toBe(200);
    await stub.ensureDatabase(name);
    for (const document of Object.values(fixture.localDocuments)) {
      await stub.putDocument(name, withoutRevision(document as JsonObject));
    }
    await stub.putDocument(name, { _id: 'h:recreated-search', type: 'leaf', data: 'recreated database marker' });
    await stub.putDocument(name, {
      _id: 'notes/recreated.md', path: 'notes/recreated.md', type: 'plain', datatype: 'plain',
      children: ['h:recreated-search'], size: 25, ctime: 1, mtime: 1, eden: {},
    });
    await expect(stub.searchVaultFiles({ query: 'recreated' })).resolves.toMatchObject({
      ok: true, data: { results: [expect.objectContaining({ path: 'notes/recreated.md' })] },
    });
    await expect(stub.searchVaultFiles({ query: 'MCP fixture' })).resolves.toMatchObject({
      ok: true, data: { results: [] },
    });
  });

  it('invalidates search before a partially failing purge', async () => {
    const { name, stub } = await seededVault('search-partial-purge');
    await stub.searchVaultFiles({ query: 'naive' });
    const current = await stub.getDocument(name, 'notes/unicode-雪.md') as unknown as JsonObject;
    const response = await stub.fetch(new Request('https://test/_purge', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pouchdb-database': name },
      body: JSON.stringify({
        'notes/unicode-雪.md': [current._rev],
        'notes/missing.md': ['1-missing'],
      }),
    }));
    expect(response.ok).toBe(false);
    await expect(stub.searchVaultFiles({ query: 'naive' })).resolves.toMatchObject({
      ok: true, data: { results: [] },
    });
  });

  it('omits invalid raw numeric metadata from public listings', async () => {
    const { name, stub } = await seededVault('invalid-metadata');
    await stub.putDocument(name, {
      _id: 'invalid/metadata.md',
      path: 'invalid/metadata.md',
      type: 'plain',
      datatype: 'plain',
      children: [],
      eden: {},
      size: -1,
      ctime: 1.5,
      mtime: Number.MAX_SAFE_INTEGER + 1,
    });

    await expect(stub.listVaultFiles({ prefix: 'invalid/' })).resolves.toEqual({
      ok: true,
      data: { files: [{ path: 'invalid/metadata.md', revision: expect.any(String) }] },
    });
  });

  it('reads exact Markdown content and returns concise input and missing-file errors', async () => {
    const { stub } = await seededVault();
    const path = 'notes/unicode-雪.md';
    await expect(stub.readVaultFile({ path })).resolves.toMatchObject({
      ok: true,
      data: { path, content: fixture.files[path] },
    });
    await expect(stub.readVaultFile({ path: '../outside.md' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    for (const reserved of ['h:internal.md', 'i:internal.md', 'ix:internal.md', 'ps:internal.md', 'notes/a:b.md']) {
      await expect(stub.readVaultFile({ path: reserved })).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      });
    }
    await expect(stub.readVaultFile({ path: 'notes/missing.md' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('reads and revision-safely patches YAML frontmatter without replacing the body', async () => {
    const { stub } = await seededVault('frontmatter');
    const before = await stub.readVaultFrontmatter({ path: 'notes/frontmatter.md' });
    expect(before).toMatchObject({
      ok: true,
      data: { frontmatter: { title: 'MCP fixture' } },
    });
    const beforeRevision = (before as unknown as { data: { revision: string } }).data.revision;

    const patched = await stub.patchVaultFrontmatter({
      path: 'notes/frontmatter.md',
      updates: { status: 'active', tags: ['mcp', 'livesync'] },
      remove: ['title'],
      expectedRevision: beforeRevision,
    });
    expect(patched).toMatchObject({
      ok: true,
      data: { updated: ['status', 'tags'], removed: ['title'] },
    });
    await expect(stub.readVaultFile({ path: 'notes/frontmatter.md' })).resolves.toMatchObject({
      ok: true,
      data: { content: expect.stringContaining('\n# Current LiveSync\n') },
    });
    await expect(stub.readVaultFrontmatter({ path: 'notes/frontmatter.md' })).resolves.toMatchObject({
      ok: true,
      data: { frontmatter: { status: 'active', tags: ['mcp', 'livesync'] } },
    });
    await expect(stub.patchVaultFrontmatter({
      path: 'notes/frontmatter.md',
      updates: { status: 'stale' },
      expectedRevision: beforeRevision,
    })).resolves.toMatchObject({ ok: false, error: { code: 'revision_conflict' } });
  });

  it('creates frontmatter with the note newline style and preserves the body verbatim', async () => {
    const { stub } = await seededVault('frontmatter-create');
    const created = await stub.createVaultFile({ path: 'notes/crlf-frontmatter.md', content: 'Body\r\n' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const patched = await stub.patchVaultFrontmatter({
      path: 'notes/crlf-frontmatter.md',
      updates: { status: 'active' },
      expectedRevision: created.data.revision,
    });
    expect(patched.ok).toBe(true);
    await expect(stub.readVaultFile({ path: 'notes/crlf-frontmatter.md' })).resolves.toMatchObject({
      ok: true,
      data: { content: '---\r\nstatus: active\r\n---\r\nBody\r\n' },
    });
  });

  it('returns a JSON-compatible view of non-JSON YAML scalars', async () => {
    const { stub } = await seededVault('frontmatter-scalars');
    const content = [
      '---',
      'positive: .inf',
      'negative: -.inf',
      'notNumber: .nan',
      'timestamp: !!timestamp 2024-01-15T12:34:56Z',
      'binary: !!binary SGVsbG8=',
      'nested:',
      '  - .nan',
      '  - !!timestamp 2024-01-15',
      '---',
      'Body',
    ].join('\n');
    const created = await stub.createVaultFile({ path: 'notes/scalars.md', content });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await expect(stub.readVaultFrontmatter({ path: 'notes/scalars.md' })).resolves.toMatchObject({
      ok: true,
      data: {
        frontmatter: {
          positive: '.inf',
          negative: '-.inf',
          notNumber: '.nan',
          timestamp: '2024-01-15T12:34:56.000Z',
          binary: 'SGVsbG8=',
          nested: ['.nan', '2024-01-15T00:00:00.000Z'],
        },
      },
    });

    await expect(stub.patchVaultFrontmatter({
      path: 'notes/scalars.md',
      updates: {
        positive: '.inf',
        timestamp: '2024-01-15T12:34:56.000Z',
        binary: 'SGVsbG8=',
      },
      expectedRevision: created.data.revision,
    })).resolves.toEqual({
      ok: true,
      data: { path: 'notes/scalars.md', revision: created.data.revision, updated: [], removed: [] },
    });
    await expect(stub.readVaultFile({ path: 'notes/scalars.md' })).resolves.toMatchObject({
      ok: true,
      data: { revision: created.data.revision, content },
    });
  });

  it('does not rewrite or advance revisions for semantic frontmatter no-ops', async () => {
    const { stub } = await seededVault('frontmatter-noop');
    const content = [
      '---',
      'status: active # preserve me',
      'obsolete: true',
      'settings:',
      '  second: 2',
      '  first: 1',
      '---',
      'Body',
    ].join('\n');
    const created = await stub.createVaultFile({ path: 'notes/noop.md', content });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const unchanged = await stub.patchVaultFrontmatter({
      path: 'notes/noop.md',
      updates: { status: 'active', settings: { first: 1, second: 2 } },
      remove: ['missing'],
      expectedRevision: created.data.revision,
    });
    expect(unchanged).toEqual({
      ok: true,
      data: { path: 'notes/noop.md', revision: created.data.revision, updated: [], removed: [] },
    });
    await expect(stub.readVaultFile({ path: 'notes/noop.md' })).resolves.toMatchObject({
      ok: true,
      data: { revision: created.data.revision, content },
    });

    const changed = await stub.patchVaultFrontmatter({
      path: 'notes/noop.md',
      updates: { status: 'active', next: 'yes' },
      remove: ['obsolete', 'missing'],
      expectedRevision: created.data.revision,
    });
    expect(changed).toMatchObject({
      ok: true,
      data: { updated: ['next'], removed: ['obsolete'] },
    });
    if (!changed.ok) return;
    expect(changed.data.revision).not.toBe(created.data.revision);

    await expect(stub.patchVaultFrontmatter({
      path: 'notes/noop.md',
      updates: { next: 'yes' },
      expectedRevision: created.data.revision,
    })).resolves.toMatchObject({ ok: false, error: { code: 'revision_conflict' } });
  });

  it('appends and patches exact text with revision preconditions and ambiguity checks', async () => {
    const { stub } = await seededVault('derived-writes');
    const created = await stub.createVaultFile({ path: 'notes/derived.md', content: 'alpha beta beta\n' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const appended = await stub.appendVaultFile({
      path: 'notes/derived.md',
      content: 'tail',
      expectedRevision: created.data.revision,
    });
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    await expect(stub.appendVaultFile({
      path: 'notes/derived.md',
      content: 'stale',
      expectedRevision: created.data.revision,
    })).resolves.toMatchObject({ ok: false, error: { code: 'revision_conflict' } });

    await expect(stub.patchVaultFile({
      path: 'notes/derived.md',
      oldText: 'beta',
      newText: 'B',
      expectedRevision: appended.data.revision,
    })).resolves.toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    const patched = await stub.patchVaultFile({
      path: 'notes/derived.md',
      oldText: 'beta',
      newText: 'B',
      replaceAll: true,
      expectedRevision: appended.data.revision,
    });
    expect(patched).toMatchObject({ ok: true, data: { replacements: 2 } });
    await expect(stub.readVaultFile({ path: 'notes/derived.md' })).resolves.toMatchObject({
      ok: true,
      data: { content: 'alpha B B\ntail' },
    });
  });

  it('treats dollar replacement patterns literally in a single-match patch', async () => {
    const { stub } = await seededVault('literal-patch');
    const created = await stub.createVaultFile({ path: 'notes/literal.md', content: 'before TOKEN after' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const newText = "price is $& / $1 / $$ / $` / $' dollars";
    const patched = await stub.patchVaultFile({
      path: 'notes/literal.md',
      oldText: 'TOKEN',
      newText,
      expectedRevision: created.data.revision,
    });
    expect(patched).toMatchObject({ ok: true, data: { replacements: 1 } });
    await expect(stub.readVaultFile({ path: 'notes/literal.md' })).resolves.toMatchObject({
      ok: true,
      data: { content: `before ${newText} after` },
    });
  });

  it('lists and boundedly reads text and binary attachments', async () => {
    const { name, stub } = await seededVault('attachments');
    await stub.putDocument(name, { _id: 'h:text-attachment', type: 'leaf', data: 'hello' });
    await stub.putDocument(name, {
      _id: 'assets/readme.txt', path: 'assets/readme.txt', type: 'plain', datatype: 'plain',
      children: ['h:text-attachment'], ctime: 1, mtime: 2, size: 5, eden: {},
    });
    await stub.putDocument(name, { _id: 'h:binary-attachment', type: 'leaf', data: 'AAEC/w==' });
    await stub.putDocument(name, {
      _id: 'assets/pixel.png', path: 'assets/pixel.png', type: 'newnote', datatype: 'newnote',
      children: ['h:binary-attachment'], ctime: 3, mtime: 4, size: 4, eden: {},
    });

    const listed = await stub.listVaultAttachments({ prefix: 'assets/' });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data.attachments.map(({ path, mimeType, sizeBytes }) => ({ path, mimeType, sizeBytes })))
      .toEqual([
        { path: 'assets/pixel.png', mimeType: 'image/png', sizeBytes: 4 },
        { path: 'assets/readme.txt', mimeType: 'text/plain', sizeBytes: 5 },
      ]);
    await expect(stub.readVaultAttachment({ path: 'assets/readme.txt' })).resolves.toMatchObject({
      ok: true,
      data: { contentBase64: 'aGVsbG8=', sizeBytes: 5, mimeType: 'text/plain' },
    });
    await expect(stub.readVaultAttachment({ path: 'assets/pixel.png' })).resolves.toMatchObject({
      ok: true,
      data: { contentBase64: 'AAEC/w==', sizeBytes: 4, mimeType: 'image/png' },
    });
    await expect(stub.readVaultAttachment({ path: 'notes/frontmatter.md' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
  });

  it('enforces the decoded attachment limit even when metadata understates the size', async () => {
    const { name, stub } = await seededVault('attachment-limit');
    await stub.putDocument(name, { _id: 'h:oversized-binary', type: 'leaf', data: 'A'.repeat(700_000) });
    await stub.putDocument(name, {
      _id: 'assets/oversized.bin', path: 'assets/oversized.bin', type: 'newnote', datatype: 'newnote',
      children: ['h:oversized-binary'], ctime: 1, mtime: 1, size: 1, eden: {},
    });
    await expect(stub.readVaultAttachment({ path: 'assets/oversized.bin' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'too_large' },
    });
  });

  it.each([undefined, 1])('bounds chunk loading when metadata size is %s', async (declaredSize) => {
    const { name, stub } = await seededVault('bounded-read');
    const path = 'notes/oversized.md';
    const chunkIds = ['h:bounded-1', 'h:bounded-2', 'h:bounded-3', 'h:bounded-4'];
    for (const id of chunkIds) {
      await stub.putDocument(name, { _id: id, type: 'leaf', data: 'x'.repeat(180_000) });
    }
    await stub.putDocument(name, {
      _id: path,
      path,
      type: 'plain',
      children: chunkIds,
      ctime: 1,
      mtime: 1,
      ...(declaredSize === undefined ? {} : { size: declaredSize }),
      eden: {},
    });

    const observed = await runInDurableObject(stub, async (instance: PouchDatabase) => {
      const originalFetch = instance.fetch.bind(instance);
      const requestedChunks: string[] = [];
      instance.fetch = async (request: Request) => {
        const pathname = decodeURIComponent(new URL(request.url).pathname).slice(1);
        if (request.method === 'GET' && pathname.startsWith('h:bounded-')) requestedChunks.push(pathname);
        return originalFetch(request);
      };
      try {
        const result = await instance.readVaultFile({ path });
        return { result, requestedChunks };
      } finally {
        instance.fetch = originalFetch;
      }
    });

    expect(observed.result).toMatchObject({ ok: false, error: { code: 'too_large' } });
    expect(observed.requestedChunks).toEqual(chunkIds.slice(0, 3));
  });

  it('fails closed for an unsupported profile', async () => {
    const { name, stub } = await seededVault('unsupported-profile');
    const milestone = await stub.getDocument(name, '_local/obsydian_livesync_milestone') as unknown as JsonObject;
    const preferred = ((milestone.tweak_values as JsonObject).PREFERRED as JsonObject);
    preferred.encrypt = true;
    await stub.putDocument(name, milestone);

    await expect(stub.readVaultFile({ path: 'notes/frontmatter.md' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'unsupported' },
    });
  });

  it('does not keep a Commonlib session after a read and promptly aborts a pending long-poll', async () => {
    const { stub } = await seededVault('session-teardown');
    await stub.readVaultFile({ path: 'notes/frontmatter.md' });
    const lifecycle = await runInDurableObject(stub, async (instance: PouchDatabase) => {
      const longpollsBefore = instance['activeChangeLongpolls'];
      const controller = new AbortController();
      const pending = instance.fetch(new Request(
        'https://livesync.invalid/_changes?feed=longpoll&since=now&timeout=55000',
        {
          headers: { 'x-pouchdb-database': instance['dbName'] ?? '' },
          signal: controller.signal,
        },
      ));
      for (let attempt = 0; attempt < 20 && instance['activeChangeLongpolls'] === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const activeBeforeAbort = instance['activeChangeLongpolls'];
      controller.abort();
      const settledPromptly = await Promise.race([
        pending.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]);
      return {
        longpollsBefore,
        activeBeforeAbort,
        settledPromptly,
        activeAfterAbort: instance['activeChangeLongpolls'],
      };
    });
    expect(lifecycle).toEqual({
      longpollsBefore: 0,
      activeBeforeAbort: 1,
      settledPromptly: true,
      activeAfterAbort: 0,
    });
  });

  it('retries Commonlib construction after a transient failure', async () => {
    const { stub } = await seededVault('sticky-create');
    await runInDurableObject(stub, (instance: PouchDatabase) => {
      const create = instance['createCommonlib'].bind(instance);
      let failOnce = true;
      instance['createCommonlib'] = async (profile) => {
        if (failOnce) {
          failOnce = false;
          throw Object.assign(new Error('transient'), { status: 503 });
        }
        return create(profile);
      };
    });
    await expect(stub.listVaultFiles({})).resolves.toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
    await expect(stub.listVaultFiles({})).resolves.toMatchObject({
      ok: true,
    });
  });

  it('hides deleted and binary notes from listing and fails closed on read', async () => {
    const { name, stub } = await seededVault('tombstone');
    await stub.putDocument(name, {
      _id: 'notes/deleted.md',
      path: 'notes/deleted.md',
      type: 'plain',
      datatype: 'plain',
      children: [],
      ctime: 1,
      mtime: 1,
      size: 0,
      deleted: true,
      eden: {},
    });
    await stub.putDocument(name, {
      _id: 'notes/binary.md',
      path: 'notes/binary.md',
      type: 'newnote',
      datatype: 'newnote',
      children: [],
      ctime: 1,
      mtime: 1,
      size: 4,
      eden: {},
    });
    await stub.putDocument(name, {
      _id: 'notes/casetest.md',
      path: 'Notes/CaseTest.md',
      type: 'plain',
      datatype: 'plain',
      children: [],
      ctime: 1,
      mtime: 1,
      size: 0,
      eden: {},
    });

    const listed = await stub.listVaultFiles({ prefix: 'notes/' });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const paths = listed.data.files.map((file) => file.path);
    expect(paths).not.toContain('notes/deleted.md');
    expect(paths).not.toContain('notes/binary.md');
    expect(paths).toContain('Notes/CaseTest.md');

    await expect(stub.readVaultFile({ path: 'notes/deleted.md' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    await expect(stub.readVaultFile({ path: 'notes/binary.md' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'unsupported' },
    });
    const binary = await stub.getDocument(name, 'notes/binary.md') as unknown as { _rev: string };
    await expect(stub.deleteVaultFile({
      path: 'notes/binary.md',
      expectedRevision: String(binary._rev),
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'unsupported' },
    });
    await expect(stub.getDocument(name, 'notes/binary.md')).resolves.not.toHaveProperty('deleted', true);

    const caseEntry = await stub.getDocument(name, 'notes/casetest.md') as unknown as { _rev: string };
    await expect(stub.updateVaultFile({
      path: 'notes/casetest.md',
      content: 'preserve canonical case\n',
      expectedRevision: String(caseEntry._rev),
    })).resolves.toMatchObject({
      ok: true,
      data: { path: 'Notes/CaseTest.md' },
    });
    await expect(stub.getDocument(name, 'notes/casetest.md')).resolves.toMatchObject({
      path: 'Notes/CaseTest.md',
    });
    await expect(stub.readVaultFile({ path: '_design/foo.md' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    await expect(stub.readVaultFile({ path: '_local/foo.md' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
  });

  it('creates, edits, and deletes Markdown notes', async () => {
    const { stub } = await seededVault('vault-write');
    const created = await stub.createVaultFile({
      path: 'notes/created.md',
      content: '# Created\nhello\n',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await expect(stub.readVaultFile({ path: 'notes/created.md' })).resolves.toMatchObject({
      ok: true,
      data: { content: '# Created\nhello\n' },
    });
    await expect(stub.createVaultFile({
      path: 'notes/created.md',
      content: '# again\n',
    })).resolves.toMatchObject({ ok: false, error: { code: 'revision_conflict' } });

    const edited = await stub.updateVaultFile({
      path: 'notes/created.md',
      content: '# Edited\n',
      expectedRevision: created.data.revision,
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    await expect(stub.updateVaultFile({
      path: 'notes/created.md',
      content: '# stale\n',
      expectedRevision: created.data.revision,
    })).resolves.toMatchObject({ ok: false, error: { code: 'revision_conflict' } });
    await expect(stub.readVaultFile({ path: 'notes/created.md' })).resolves.toMatchObject({
      ok: true,
      data: { content: '# Edited\n' },
    });

    const listed = await stub.listVaultFiles({ prefix: 'notes/' });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const paths = listed.data.files.map((file) => file.path);
    expect(paths).toContain('notes/created.md');

    await expect(stub.deleteVaultFile({
      path: 'notes/created.md',
      expectedRevision: edited.data.revision,
    })).resolves.toMatchObject({ ok: true });
    await expect(stub.readVaultFile({ path: 'notes/created.md' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    const afterDelete = await stub.listVaultFiles({ prefix: 'notes/' });
    expect(afterDelete.ok).toBe(true);
    if (!afterDelete.ok) return;
    expect(afterDelete.data.files.map((file) => file.path)).not.toContain('notes/created.md');
  });

  it('enforces create CAS when another client wins after Commonlib preflight', async () => {
    const { name, stub } = await seededVault('create-race');
    const externalContent = 'external winner\n';
    const xxhash = await xxhashNew();
    const externalChunkId = `h:${xxhash.h64(`${externalContent}-${externalContent.length}`).toString(36)}`;
    await stub.putDocument(name, { _id: externalChunkId, type: 'leaf', data: externalContent });
    const raced = await runInDurableObject(stub, async (instance: PouchDatabase) => {
      const originalFetch = instance.fetch.bind(instance);
      let metadataPuts = 0;
      const metadataStatuses: number[] = [];
      let reachedMetadataPut!: () => void;
      const commonlibAtMetadataPut = new Promise<void>((resolve) => { reachedMetadataPut = resolve; });
      let release!: () => void;
      const releaseCommonlibPut = new Promise<void>((resolve) => { release = resolve; });
      instance.fetch = async (request: Request) => {
        const url = new URL(request.url);
        const isTargetMetadataPut = request.method === 'PUT'
          && decodeURIComponent(url.pathname) === '/notes/create-race.md';
        if (!isTargetMetadataPut) return originalFetch(request);
        metadataPuts += 1;
        reachedMetadataPut();
        await releaseCommonlibPut;
        const response = await originalFetch(request);
        metadataStatuses.push(response.status);
        return response;
      };
      const profile = await instance['inspectCommonlibProfile']();
      const facade = new CommonlibFacade(name, instance['inProcessCouchFetch'](), profile);
      try {
        const commonlibWrite = facade.write(
          'notes/create-race.md',
          'commonlib loser\n',
          { ctime: 1, mtime: 1, size: 17 },
        );
        await commonlibAtMetadataPut;
        const externalResponse = await originalFetch(new Request(
          'https://livesync.invalid/notes%2Fcreate-race.md',
          {
            method: 'PUT',
            headers: {
              'content-type': 'application/json',
              'x-pouchdb-database': name,
            },
            body: JSON.stringify({
              _id: 'notes/create-race.md',
              path: 'notes/create-race.md',
              type: 'plain',
              children: [externalChunkId],
              ctime: 2,
              mtime: 2,
              size: externalContent.length,
              eden: {},
            }),
          },
        ));
        metadataPuts += 1;
        metadataStatuses.push(externalResponse.status);
        release();
        const commonlibResult = await commonlibWrite;
        return { commonlibResult, metadataPuts, metadataStatuses: metadataStatuses.sort() };
      } finally {
        release();
        await facade.close();
        instance.fetch = originalFetch;
      }
    });
    expect(raced.metadataPuts).toBe(2);
    expect(raced.metadataStatuses).toEqual([201, 409]);
    expect(raced.commonlibResult).toBe(false);
    const read = await stub.readVaultFile({ path: 'notes/create-race.md' });
    expect(read).toMatchObject({ ok: true, data: { content: externalContent } });
    if (!read.ok) return;
    await expect(stub.getDocument(name, 'notes/create-race.md', { conflicts: true })).resolves.not.toHaveProperty('_conflicts');
  });

  it('allows one winner for concurrent updates from the same revision', async () => {
    const { name, stub } = await seededVault('update-race');
    const created = await stub.createVaultFile({ path: 'notes/update-race.md', content: 'base\n' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const results = await Promise.all([
      stub.updateVaultFile({ path: 'notes/update-race.md', content: 'first\n', expectedRevision: created.data.revision }),
      stub.updateVaultFile({ path: 'notes/update-race.md', content: 'second\n', expectedRevision: created.data.revision }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    const read = await stub.readVaultFile({ path: 'notes/update-race.md' });
    expect(read.ok).toBe(true);
    if (read.ok) expect(['first\n', 'second\n']).toContain(read.data.content);
    await expect(stub.getDocument(name, 'notes/update-race.md', { conflicts: true })).resolves.not.toHaveProperty('_conflicts');
  });

  it('allows one winner for concurrent derived writes from the same revision', async () => {
    const { name, stub } = await seededVault('derived-race');
    const created = await stub.createVaultFile({ path: 'notes/derived-race.md', content: 'base\n' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const results = await Promise.all([
      stub.appendVaultFile({ path: 'notes/derived-race.md', content: 'first\n', expectedRevision: created.data.revision }),
      stub.patchVaultFrontmatter({ path: 'notes/derived-race.md', updates: { winner: true }, expectedRevision: created.data.revision }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    await expect(stub.getDocument(name, 'notes/derived-race.md', { conflicts: true })).resolves.not.toHaveProperty('_conflicts');
  });

  it('allows one winner for an update/delete race and safely revives the tombstone', async () => {
    const { name, stub } = await seededVault('delete-race');
    const created = await stub.createVaultFile({ path: 'notes/delete-race.md', content: 'base\n' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const results = await Promise.all([
      stub.updateVaultFile({ path: 'notes/delete-race.md', content: 'updated\n', expectedRevision: created.data.revision }),
      stub.deleteVaultFile({ path: 'notes/delete-race.md', expectedRevision: created.data.revision }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    await expect(stub.getDocument(name, 'notes/delete-race.md', { conflicts: true })).resolves.not.toHaveProperty('_conflicts');

    const current = await stub.readVaultFile({ path: 'notes/delete-race.md' });
    if (current.ok) {
      const removed = await stub.deleteVaultFile({
        path: 'notes/delete-race.md',
        expectedRevision: current.data.revision,
      });
      expect(removed.ok).toBe(true);
    }
    const revived = await stub.createVaultFile({ path: 'notes/delete-race.md', content: 'revived\n' });
    expect(revived.ok).toBe(true);
    await expect(stub.readVaultFile({ path: 'notes/delete-race.md' })).resolves.toMatchObject({
      ok: true,
      data: { content: 'revived\n' },
    });
    await expect(stub.getDocument(name, 'notes/delete-race.md', { conflicts: true })).resolves.not.toHaveProperty('_conflicts');
  });

  it('writes current-client xxhash64 chunk identifiers in workerd', async () => {
    const { name, stub } = await seededVault('xxhash-write');
    const content = '雪🙂 current LiveSync\r\n'.repeat(300);
    const created = await stub.createVaultFile({ path: 'notes/xxhash.md', content });
    expect(created.ok).toBe(true);
    const metadata = await stub.getDocument(name, 'notes/xxhash.md') as unknown as JsonObject;
    const children = metadata.children as string[];
    expect(children.length).toBeGreaterThan(1);

    const xxhash = await xxhashNew();
    for (const childId of children) {
      const chunk = await stub.getDocument(name, childId) as unknown as JsonObject;
      const piece = chunk.data as string;
      expect(childId).toBe(`h:${xxhash.h64(`${piece}-${piece.length}`).toString(36)}`);
    }
    await expect(stub.readVaultFile({ path: 'notes/xxhash.md' })).resolves.toMatchObject({
      ok: true,
      data: { content },
    });
  });
});

describe('filtered search and partial reads', () => {
  it('queries typed properties with literal keys, normalized tags, dates, null and invalid YAML', async () => {
    const { stub } = await seededVault('properties');
    await stub.createVaultFile({ path: 'queries/a.md', content: '---\nstatus: open\ntags: "#project, other"\nscore: 12\ndue: 2026-01-02\n"a.b": yes\nnil: null\n---\npropertymarker\n' });
    await stub.createVaultFile({ path: 'queries/b.md', content: '---\nstatus: closed\nscore: "12"\n---\npropertymarker\n' });
    await stub.createVaultFile({ path: 'queries/bad.md', content: '---\ninvalid: [\n---\npropertymarker\n' });
    const filters = [
      { property: 'status', operator: 'eq' as const, value: 'open' },
      { property: 'tags', operator: 'contains' as const, value: '#project' },
      { property: 'score', operator: 'gte' as const, type: 'number' as const, value: 10 },
      { property: 'due', operator: 'lt' as const, type: 'date' as const, value: '2026-02-01' },
      { property: 'a.b', operator: 'eq' as const, value: 'yes' },
      { property: 'nil', operator: 'eq' as const, value: null },
    ];
    await expect(stub.searchVaultFiles({ pathPrefix: 'queries/', filters, properties: ['status', 'tags', 'missing'] })).resolves.toMatchObject({
      ok: true, data: { results: [{ path: 'queries/a.md', properties: { status: 'open', tags: ['project', 'other'] } }], incomplete: true, unqueryableFiles: 1 },
    });
    await expect(stub.searchVaultFiles({ query: 'propertymarker' })).resolves.toMatchObject({ ok: true, data: { results: [{}, {}, {}], incomplete: false } });
    await expect(stub.searchVaultFiles({ pathPrefix: 'queries/', filters: [{ property: 'nil', operator: 'exists', value: false }] })).resolves.toMatchObject({ ok: true, data: { results: [{ path: 'queries/b.md' }] } });
    await expect(stub.searchVaultFiles({ filters: [{ property: "x') OR 1=1 --", operator: 'eq', value: 'open' }] })).resolves.toMatchObject({ ok: true, data: { results: [] } });
  });

  it('paginates text and property queries exhaustively and expires cursors after indexed edits', async () => {
    const { stub } = await seededVault('pagination');
    for (let index = 0; index < 57; index++) await stub.createVaultFile({ path: `pages/${String(index).padStart(3, '0')}.md`, content: '---\nstatus: open\n---\npaginationmarker\n' });
    for (const query of [{ query: 'paginationmarker' }, { filters: [{ property: 'status', operator: 'eq' as const, value: 'open' }] }]) {
      let cursor: string | undefined;
      const paths: string[] = [];
      do {
        const page = await stub.searchVaultFiles({ ...query, pathPrefix: 'pages/', limit: 20, cursor });
        expect(page.ok).toBe(true); if (!page.ok) return;
        paths.push(...page.data.results.map((row) => row.path)); cursor = page.data.cursor;
      } while (cursor);
      expect(paths).toHaveLength(57); expect(new Set(paths).size).toBe(57);
    }
    const first = await stub.searchVaultFiles({ query: 'paginationmarker', limit: 2 });
    if (!first.ok) throw new Error('search failed');
    await expect(stub.searchVaultFiles({ query: 'other', cursor: first.data.cursor })).resolves.toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    const note = await stub.readVaultFile({ path: 'pages/000.md' }); if (!note.ok) throw new Error('read failed');
    await stub.appendVaultFile({ path: note.data.path, expectedRevision: note.data.revision, content: 'changed' });
    await expect(stub.searchVaultFiles({ query: 'paginationmarker', cursor: first.data.cursor })).resolves.toMatchObject({ ok: false, error: { code: 'cursor_expired' } });
    const fresh = await stub.searchVaultFiles({ query: 'paginationmarker', limit: 2 }); if (!fresh.ok) return;
    await runInDurableObject(stub, async (instance: PouchDatabase) => { instance['search']().invalidatePurgedDocuments([]); });
    await expect(stub.searchVaultFiles({ query: 'paginationmarker', cursor: fresh.data.cursor })).resolves.toMatchObject({ ok: false, error: { code: 'cursor_expired' } });
  });

  it('returns headings and exact line ranges without treating partial content as a full note', async () => {
    const { stub } = await seededVault('outline');
    const content = '---\r\ntitle: sample\r\n---\r\n# First\r\n雪 body\r\n## Child\r\n```md\r\n# Hidden\r\n```\r\nSecond\r\n======\r\nend\r\n';
    const created = await stub.createVaultFile({ path: 'outline.md', content }); if (!created.ok) throw new Error('create failed');
    await expect(stub.getVaultFileOutline({ path: 'outline.md' })).resolves.toMatchObject({ ok: true, data: {
      totalLines: 12, headings: [{ text: 'First', level: 1, startLine: 4, endLine: 9 }, { text: 'Child', level: 2, startLine: 6, endLine: 9 }, { text: 'Second', level: 1, startLine: 10, endLine: 12 }],
    } });
    await expect(stub.readVaultFile({ path: 'outline.md', startLine: 4, endLine: 5, expectedRevision: created.data.revision })).resolves.toMatchObject({ ok: true, data: { content: '# First\r\n雪 body\r\n', partial: true, totalLines: 12 } });
    await expect(stub.readVaultFile({ path: 'outline.md', startLine: 13 })).resolves.toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    await stub.appendVaultFile({ path: 'outline.md', expectedRevision: created.data.revision, content: 'new' });
    await expect(stub.readVaultFile({ path: 'outline.md', startLine: 4, expectedRevision: created.data.revision })).resolves.toMatchObject({ ok: false, error: { code: 'revision_conflict' } });
  });

  it('ignores HTML comment headings and bounds outline parsing before allocating tokens', async () => {
    const { stub } = await seededVault('outline-limits');
    await stub.createVaultFile({ path: 'comments.md', content: '# [Same][ref]\n<!--\n# Hidden\n-->\n# Same\n\n[ref]: https://example.com\n' });
    await expect(stub.getVaultFileOutline({ path: 'comments.md' })).resolves.toMatchObject({ ok: true, data: {
      headings: [{ text: 'Same', startLine: 1, endLine: 4 }, { text: 'Same', startLine: 5, endLine: 7 }],
    } });
    for (const [path, content] of [['dense.md', '#\n'.repeat(10000)], ['headings.md', '# x\n'.repeat(1025)], ['long-heading.md', '# ' + 'x'.repeat(33000)]]) {
      expect((await stub.createVaultFile({ path, content })).ok).toBe(true);
      await expect(stub.getVaultFileOutline({ path })).resolves.toMatchObject({ ok: false, error: { code: 'too_large' } });
      expect((await stub.readVaultFile({ path, startLine: 1, endLine: 1 })).ok).toBe(true);
    }
  });

  it('continues byte-shortened pages after recreating the derived index reader', async () => {
    const { stub } = await seededVault('byte-pages');
    for (let index = 0; index < 5; index++) await stub.createVaultFile({ path: `large-properties/${index}.md`, content: `---\nstatus: open\nlarge: ${'x'.repeat(18000)}\n---\n` });
    const request = { pathPrefix: 'large-properties/', filters: [{ property: 'status', operator: 'eq' as const, value: 'open' }], properties: ['large'], limit: 50 };
    const first = await stub.searchVaultFiles(request);
    if (!first.ok) throw new Error('search failed');
    expect(first.data.results.length).toBeLessThan(5);
    expect(first.data.cursor).toBeTruthy();
    // Each RPC constructs a fresh search reader; continuation uses only persisted SQL state.
    const paths = first.data.results.map((row) => row.path);
    let cursor = first.data.cursor;
    while (cursor) {
      const next = await stub.searchVaultFiles({ ...request, cursor });
      if (!next.ok) throw new Error(next.error.code);
      paths.push(...next.data.results.map((row) => row.path)); cursor = next.data.cursor;
    }
    expect(paths).toHaveLength(5); expect(new Set(paths).size).toBe(5);
  });

  it('fails cleanup closed on unreadable leaves and serializes encoded purge with writes', async () => {
    const { name, stub } = await seededVault('maintenance-safety');
    const chunk = await stub.putDocument(name, { _id: 'h:orphan-safety', type: 'leaf', data: 'orphan' });
    const outcome = await runInDurableObject(stub, async (instance: PouchDatabase) => {
      const db = instance['database']();
      const purgeRequest = () => new Request('https://livesync.invalid/%5Fpurge', { method: 'POST', headers: { 'x-pouchdb-database': name }, body: JSON.stringify({ 'h:orphan-safety': [chunk.rev] }) });
      const get = db.get.bind(db);
      db.get = ((id: string, options: object) => id === 'notes/frontmatter.md' ? Promise.reject(new Error('unreadable leaf')) : get(id, options)) as typeof db.get;
      const failed = await instance.fetch(purgeRequest());
      db.get = get as typeof db.get;
      let release!: () => void;
      let started!: () => void;
      const began = new Promise<void>((resolve) => { started = resolve; });
      const hold = new Promise<void>((resolve) => { release = resolve; });
      const write = instance['withSemanticWrite'](async () => { started(); await hold; return { ok: true as const, data: {} }; });
      await began;
      const busy = await instance.fetch(purgeRequest());
      release(); await write;
      return { failed: failed.status, busy: busy.status, chunk: await db.get('h:orphan-safety') };
    });
    expect(outcome).toMatchObject({ failed: 503, busy: 409, chunk: { data: 'orphan' } });
  });

  it('bounds replication hydration and holds authoritative writes until purge validation finishes', async () => {
    const { name, stub } = await seededVault('bounded-gate');
    for (let index = 0; index < 40; index++) await stub.putDocument(name, { _id: `raw-${index}`, value: index });
    const chunk = await stub.putDocument(name, { _id: 'h:gate-orphan', type: 'leaf', data: 'orphan' });
    const observed = await runInDurableObject(stub, async (instance: PouchDatabase) => {
      const db = instance['database']();
      const changes = db.changes.bind(db);
      const batchSizes: number[] = [];
      db.changes = ((options: PouchDB.Core.ChangesOptions) => {
        batchSizes.push(options.doc_ids?.length ?? Infinity);
        expect(options.limit).toBeLessThanOrEqual(16);
        return changes(options);
      }) as typeof db.changes;
      const feed = await instance.fetch(new Request('https://livesync.invalid/_changes', { headers: { 'x-pouchdb-database': name } }));
      const feedBody = await feed.json() as { results: unknown[] };
      db.changes = changes as typeof db.changes;
      const get = db.get.bind(db);
      let release!: () => void;
      let started!: () => void;
      const began = new Promise<void>((resolve) => { started = resolve; });
      const hold = new Promise<void>((resolve) => { release = resolve; });
      let once = false;
      db.get = (async (id: string, options: object) => {
        if (!once && id === 'notes/frontmatter.md') { once = true; started(); await hold; }
        return get(id, options);
      }) as typeof db.get;
      const purge = instance.fetch(new Request('https://livesync.invalid/%5Fpurge', { method: 'POST', headers: { 'x-pouchdb-database': name }, body: JSON.stringify({ 'h:gate-orphan': [chunk.rev] }) }));
      await began;
      let written = false;
      const write = instance.putDocument(name, { _id: 'after-maintenance', value: 1 }).then(() => { written = true; });
      await Promise.resolve(); await Promise.resolve();
      const duringValidation = written;
      release(); const response = await purge; await write;
      db.get = get as typeof db.get;
      return { batchSizes, results: feedBody.results.length, duringValidation, purge: response.status, written };
    });
    expect(Math.max(...observed.batchSizes)).toBeLessThanOrEqual(16);
    expect(observed.batchSizes.length).toBeGreaterThan(2);
    expect(observed.results).toBeGreaterThan(40);
    expect(observed).toMatchObject({ duringValidation: false, purge: 200, written: true });
  });

  it('preserves both files when a composed copy/delete races a source edit', async () => {
    const { stub } = await seededVault('copy-delete');
    await stub.createVaultFile({ path: 'source.md', content: 'original' });
    const read = await stub.readVaultFile({ path: 'source.md' }); if (!read.ok) throw new Error('read');
    await stub.createVaultFile({ path: 'destination.md', content: read.data.content });
    await stub.appendVaultFile({ path: 'source.md', expectedRevision: read.data.revision, content: ' newer' });
    await expect(stub.deleteVaultFile({ path: 'source.md', expectedRevision: read.data.revision })).resolves.toMatchObject({ ok: false, error: { code: 'revision_conflict' } });
    await expect(stub.readVaultFile({ path: 'source.md' })).resolves.toMatchObject({ ok: true, data: { content: 'original newer' } });
    await expect(stub.readVaultFile({ path: 'destination.md' })).resolves.toMatchObject({ ok: true, data: { content: 'original' } });
  });
});
