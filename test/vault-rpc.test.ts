import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import fixture from './fixtures/livesync-1.0.21.json';
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
});
