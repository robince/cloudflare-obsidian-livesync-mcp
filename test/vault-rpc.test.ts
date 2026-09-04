import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
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
      data: { contractVersion: 2, compatible: true, reasons: [] },
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
    })).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } });
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
    })).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } });
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
    })).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } });

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
    })).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } });

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
    })).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } });
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
