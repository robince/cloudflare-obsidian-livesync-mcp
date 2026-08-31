import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import fixture from './fixtures/livesync-1.0.21.json';
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

describe('read-only vault RPC', () => {
  it('reports the current fixture profile', async () => {
    const { stub } = await seededVault();
    const status = await stub.vaultStatus();

    expect(status).toEqual({
      ok: true,
      data: { contractVersion: 1, compatible: true, reasons: [] },
    });
  });

  it('lists Markdown files with a prefix-bound best-effort cursor', async () => {
    const { stub } = await seededVault();
    const first = await stub.listVaultFiles({ prefix: 'notes/', limit: 2 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.files).toHaveLength(2);
    expect(first.data.files.every((file) => file.path.startsWith('notes/'))).toBe(true);
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
    await expect(stub.readVaultFile({ path: 'h:internal.md' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    await expect(stub.readVaultFile({ path: 'notes/missing.md' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
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

  it('does not keep a Commonlib session after a read returns', async () => {
    const { stub } = await seededVault('session-teardown');
    await stub.readVaultFile({ path: 'notes/frontmatter.md' });
    const leftover = await runInDurableObject(stub, (instance: PouchDatabase) => ({
      facade: instance['commonlibFacade'],
      refs: instance['commonlibRefs'],
    }));
    expect(leftover).toEqual({ facade: undefined, refs: 0 });
  });

  it('retries Commonlib construction after a rejected create', async () => {
    const { stub } = await seededVault('sticky-create');
    await runInDurableObject(stub, (instance: PouchDatabase) => {
      const failed = Promise.reject(Object.assign(new Error('transient'), { status: 503 }));
      void failed.catch(() => undefined);
      instance['commonlibCreate'] = failed;
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
    await expect(stub.readVaultFile({ path: '_design/foo.md' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
  });

  it('creates, edits, moves, and deletes Markdown notes', async () => {
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

    const moved = await stub.moveVaultFile({
      from: 'notes/created.md',
      to: 'notes/moved.md',
      expectedRevision: edited.data.revision,
    });
    expect(moved).toMatchObject({ ok: true });
    if (!moved.ok) return;
    await expect(stub.readVaultFile({ path: 'notes/created.md' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    await expect(stub.readVaultFile({ path: 'notes/moved.md' })).resolves.toMatchObject({
      ok: true,
      data: { content: '# Edited\n' },
    });

    const listed = await stub.listVaultFiles({ prefix: 'notes/' });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const paths = listed.data.files.map((file) => file.path);
    expect(paths).toContain('notes/moved.md');
    expect(paths).not.toContain('notes/created.md');

    await expect(stub.deleteVaultFile({
      path: 'notes/moved.md',
      expectedRevision: moved.data.revision,
    })).resolves.toMatchObject({ ok: true });
    await expect(stub.readVaultFile({ path: 'notes/moved.md' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    const afterDelete = await stub.listVaultFiles({ prefix: 'notes/' });
    expect(afterDelete.ok).toBe(true);
    if (!afterDelete.ok) return;
    expect(afterDelete.data.files.map((file) => file.path)).not.toContain('notes/moved.md');
  });
});
