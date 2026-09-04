import { describe, expect, it } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import type { PouchDatabase } from '../src/pouch-database';
import { conflictVault } from './conflict-fixtures';

describe('LiveSync revision-tree conflicts', () => {
  it('reports conflicts on reads/frontmatter/listings without changing any leaf', async () => {
    const { stub, path, tree } = await conflictVault();
    const before = await tree();
    for (const read of [stub.readVaultFile({ path }), stub.readVaultFrontmatter({ path })]) {
      expect(await read).toMatchObject({ ok: false, error: {
        code: 'livesync_conflict', path, unresolvedVersions: 2, resolution: 'obsidian',
      } });
    }
    expect(await stub.listVaultFiles({})).toMatchObject({ ok: true, data: {
      files: [expect.objectContaining({ path, unresolvedVersions: 2 })],
    } });
    expect(await tree()).toEqual(before);
  });

  it('uses Commonlib to merge without applying the triggering mutation', async () => {
    const { stub, path, tree } = await conflictVault();
    expect(await stub.appendVaultFile({ path, expectedRevision: '2-b', content: 'NEVER' }))
      .toMatchObject({ ok: false, error: { code: 'conflict_reconciled', path, resolution: 'reread_and_reassess' } });
    expect(await tree()).toHaveLength(1);
    const read = await stub.readVaultFile({ path });
    expect(read).toMatchObject({ ok: true, data: { content: 'A\nbase\nB\n' } });
    if (!read.ok) return;
    expect(await stub.appendVaultFile({ path, expectedRevision: read.data.revision, content: ' deliberate' }))
      .toMatchObject({ ok: true });
  });

  it.each([
    { leaves: ['left\n', 'right\n'], base: 'base\n' },
    { deleted: 1 },
    { unrelated: true },
    { missingBase: true },
    { missingChunk: 0 },
  ])('preserves unsafe conflicts exactly: %j', async (options) => {
    const { stub, path, tree } = await conflictVault(options);
    const before = await tree();
    for (const call of [
      () => stub.updateVaultFile({ path, expectedRevision: '2-b', content: 'NEVER' }),
      () => stub.deleteVaultFile({ path, expectedRevision: '2-b' }),
      () => stub.createVaultFile({ path, content: 'NEVER' }),
    ]) {
      expect(await call()).toMatchObject({ ok: false, error: { code: 'livesync_conflict', resolution: 'obsidian' } });
      expect(await tree()).toEqual(before);
    }
  });

  it('collapses identical bytes with the host duplicate policy and no synthesized content', async () => {
    const { stub, path, tree } = await conflictVault({ leaves: ['same', 'same'] });
    expect(await stub.deleteVaultFile({ path, expectedRevision: '2-b' }))
      .toMatchObject({ ok: false, error: { code: 'conflict_reconciled' } });
    expect(await tree()).toMatchObject([{ _rev: '2-b' }]);
    expect(await stub.readVaultFile({ path })).toMatchObject({ ok: true, data: { content: 'same' } });
  });

  it('makes partial pairwise progress and stops before a manual pair', async () => {
    const { stub, path, tree } = await conflictVault({ leaves: ['A\nbase\nend\n', 'X\nbase\nB\n', 'start\nbase\nB\n'] });
    expect(await stub.deleteVaultFile({ path, expectedRevision: '2-c' }))
      .toMatchObject({ ok: false, error: { code: 'conflict_reconciled', unresolvedVersions: 2 } });
    const after = await tree();
    expect(after).toHaveLength(2);
    expect(after.some(doc => doc._rev === '2-b')).toBe(true);
    expect(await stub.deleteVaultFile({ path, expectedRevision: '2-c' }))
      .toMatchObject({ ok: false, error: { code: 'livesync_conflict' } });
    expect(await tree()).toEqual(after);
  });

  it('reports differing binary versions without applying newer-mtime policy', async () => {
    const { stub, path, tree } = await conflictVault({ path: 'assets/image.png', binary: true, leaves: ['AA==', 'AQ=='] });
    const before = await tree();
    expect(await stub.readVaultAttachment({ path })).toMatchObject({ ok: false, error: { code: 'livesync_conflict' } });
    expect(await stub.listVaultAttachments({})).toMatchObject({ ok: true, data: {
      attachments: [expect.objectContaining({ path, unresolvedVersions: 2 })],
    } });
    expect(await tree()).toEqual(before);
  });

  it('preserves a losing leaf advanced concurrently before removal', async () => {
    const { stub, name, path, tree } = await conflictVault();
    const result = await runInDurableObject(stub, async (instance: PouchDatabase) => {
      const original = instance.fetch.bind(instance);
      let raced = false;
      instance.fetch = async request => {
        if (request.method === 'DELETE' && !raced) {
          raced = true;
          const loser = await instance.getDocument(name, path, { rev: '2-a' });
          await instance.putDocument(name, { ...loser, mtime: 9000 });
        }
        return original(request);
      };
      try { return await instance.deleteVaultFile({ path, expectedRevision: '2-b' }); }
      finally { instance.fetch = original; }
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'conflict_reconciled' } });
    expect(await tree()).toHaveLength(2);
  });

  it('bounds pairwise work and preserves the remaining duplicate leaves', async () => {
    const { stub, path, tree } = await conflictVault({ leaves: Array(10).fill('same') });
    expect(await stub.deleteVaultFile({ path, expectedRevision: '2-j' }))
      .toMatchObject({ ok: false, error: { code: 'conflict_reconciled', unresolvedVersions: 2 } });
    expect(await tree()).toHaveLength(2);
  });

  it('rejects a raced winning CAS without deleting the observed losing leaf', async () => {
    const { stub, name, path, tree } = await conflictVault();
    const result = await runInDurableObject(stub, async (instance: PouchDatabase) => {
      const original = instance.fetch.bind(instance);
      let raced = false;
      instance.fetch = async request => {
        if (request.method === 'PUT' && decodeURIComponent(new URL(request.url).pathname) === `/${path}` && !raced) {
          raced = true;
          const winner = await instance.getDocument(name, path);
          await instance.putDocument(name, { ...winner, mtime: 9000 });
        }
        return original(request);
      };
      try { return await instance.deleteVaultFile({ path, expectedRevision: '2-b' }); }
      finally { instance.fetch = original; }
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'livesync_conflict' } });
    const after = await tree();
    expect(after).toHaveLength(2);
    expect(after.some(doc => doc._rev === '2-a')).toBe(true);
  });
});
