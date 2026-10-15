import { env } from 'cloudflare:workers';
import { SELF, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import PouchDB from 'pouchdb-core';
import { pathAccess, vaultPathPolicySchema, type VaultResult } from '@cloudflare-obsidian-livesync/contracts';
import { withVaultPathPolicy } from '../apps/cloudflare-obsidian-mcp/src/vault-rpc';
import { createVaultMcpServer, VAULT_TOOL_NAMES } from '../apps/cloudflare-obsidian-mcp/src/vault-tools';
import type { PouchDatabase } from '../src/pouch-database';
import { CommonlibFacade } from '../src/livesync-vault/commonlib';
import { LiveSyncVault } from '../src/livesync-vault/vault';
import type { JsonObject } from '../src/types';
import fixture from './fixtures/livesync-1.0.21.json';
import { conflictVault } from './conflict-fixtures';
import { unrestrictedPolicy } from './vault-policy-helpers';

// Commonlib installs HTTP and replication when the first semantic note is created.
// Registering replication twice attempts to redefine its non-configurable getter.
const ReplicationPouch = PouchDB as typeof PouchDB & {
  replicate(source: PouchDB.Database, target: PouchDB.Database): Promise<{ ok: boolean }>;
};

const policy = vaultPathPolicySchema.parse({ rules: [
  { path: 'Private/', access: 'none' }, { path: 'Journal/', access: 'read' },
  { path: 'Café/', access: 'none' }, { path: '100%_private/', access: 'none' },
], hideDotFolders: true });
const denied = { ok: false, error: { code: 'access_denied', message: 'This path is not writable via MCP' } };
const missing = { ok: false, error: { code: 'not_found', message: 'File not found.' } };

function data<T>(result: VaultResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.data;
}

async function seeded(caseSensitive = true) {
  const name = `path-policy-${crypto.randomUUID().replaceAll('-', '')}`;
  const stub = env.POUCH_DATABASES.getByName(name);
  await stub.ensureDatabase(name);
  for (const doc of Object.values(fixture.localDocuments)) {
    const copy = structuredClone(doc) as JsonObject;
    delete copy._rev;
    if (copy.tweak_values) {
      const tweaks = copy.tweak_values as { PREFERRED: JsonObject };
      tweaks.PREFERRED.handleFilenameCaseSensitive = caseSensitive;
    }
    await stub.putDocument(name, copy);
  }
  const open = withVaultPathPolicy(stub, unrestrictedPolicy);
  const restricted = withVaultPathPolicy(stub, policy);
  return { name, stub, open, restricted };
}

async function note(open: ReturnType<typeof withVaultPathPolicy>, path: string, content = '---\nstatus: active\n---\n# Heading\npolicymarker\n') {
  return data(await open.createVaultFile({ path, content }));
}

async function attachment(stub: DurableObjectStub<PouchDatabase>, name: string, path: string, caseSensitive = true) {
  const child = `h:${crypto.randomUUID()}`;
  await stub.putDocument(name, { _id: child, type: 'leaf', data: 'AQID' });
  await stub.putDocument(name, { _id: caseSensitive ? path : path.toLowerCase(), path, type: 'newnote', datatype: 'newnote', children: [child], ctime: 1, mtime: 1, size: 3, eden: {} });
}

describe('semantic path access', () => {
  it.each([true, false])('enforces all reads and writes with case-sensitive vault=%s', async (caseSensitive) => {
    const { name, stub, open, restricted } = await seeded(caseSensitive);
    await note(open, 'Private/a.md');
    await note(open, 'Journal/a.md');
    await note(open, 'Cafe\u0301/a.md');
    await attachment(stub, name, 'Private/a.png', caseSensitive);
    await attachment(stub, name, 'Journal/a.png', caseSensitive);
    const before = await stub.allDocuments(name, { include_docs: true });
    for (const path of ['Private/a.md', 'private/a.md', 'Private/missing.md', 'Private./new.md', 'Private /new.md', 'Café/a.md', 'CAFE\u0301/new.md']) {
      expect(await restricted.readVaultFile({ path })).toEqual(missing);
      expect(await restricted.readVaultFrontmatter({ path })).toEqual(missing);
      expect(await restricted.getVaultFileOutline({ path })).toEqual(missing);
    }
    for (const path of ['Private/a.md', 'private/a.md', 'Private/missing.md', 'Private./new.md', 'Journal/a.md', 'journal/new.md', 'Journal /new.md', 'Café/new.md']) {
      expect(await restricted.createVaultFile({ path, content: 'changed' })).toEqual(denied);
      expect(await restricted.updateVaultFile({ path, content: 'changed', expectedRevision: '1-unknown' })).toEqual(denied);
      expect(await restricted.appendVaultFile({ path, content: 'changed', expectedRevision: '1-unknown' })).toEqual(denied);
      expect(await restricted.patchVaultFile({ path, oldText: 'Heading', newText: 'Changed', expectedRevision: '1-unknown' })).toEqual(denied);
      expect(await restricted.patchVaultFrontmatter({ path, updates: { status: 'changed' }, expectedRevision: '1-unknown' })).toEqual(denied);
      expect(await restricted.deleteVaultFile({ path, expectedRevision: '1-unknown' })).toEqual(denied);
    }
    expect(await restricted.readVaultAttachment({ path: 'Private/a.png' })).toEqual(missing);
    expect(await restricted.readVaultAttachment({ path: 'Private/missing.png' })).toEqual(missing);
    expect(data(await restricted.readVaultAttachment({ path: 'Journal/a.png' })).contentBase64).toBe('AQID');
    expect(data(await restricted.readVaultFile({ path: 'Journal/a.md' })).content).toContain('policymarker');
    expect(await stub.allDocuments(name, { include_docs: true })).toEqual(before);
    for (const path of ['Private notes/a.md', 'v1./a.md', 'Draft /a.md']) {
      const result = await restricted.createVaultFile({ path, content: 'allowed' });
      expect(result, `${path}: ${JSON.stringify(result)}`).toMatchObject({ ok: true });
    }
  });

  it('never reconciles conflicts in hidden or read-only files', async () => {
    for (const path of ['Private/conflict.md', 'Journal/conflict.md']) {
      const { stub, tree } = await conflictVault({ path });
      const before = await tree();
      const rpc = withVaultPathPolicy(stub, policy);
      expect(await rpc.appendVaultFile({ path, content: 'changed', expectedRevision: '2-b' })).toEqual(denied);
      expect(await rpc.deleteVaultFile({ path, expectedRevision: '2-b' })).toEqual(denied);
      if (path.startsWith('Private/')) expect(await rpc.readVaultFile({ path })).toEqual(missing);
      expect(await tree()).toEqual(before);
    }
  });

  it.each([true, false])('blocks Unicode case aliases across every operation, case-sensitive vault=%s', async (caseSensitive) => {
    const { name, stub, open } = await seeded(caseSensitive);
    const hidden = ['ΟΔΟΣ/a.md', 'ΟΔΟσ/a.md', 'Straße/a.md', 'STRASSE/a.md'];
    const readable = ['Μ/a.md', 'µ/a.md'];
    for (const path of [...hidden, ...readable]) await note(open, path);
    const restricted = withVaultPathPolicy(stub, vaultPathPolicySchema.parse({ rules: [
      { path: 'ΟΔΟΣ', access: 'none' }, { path: 'Straße', access: 'none' }, { path: 'Μ', access: 'read' },
    ], hideDotFolders: false }));
    for (const path of hidden) {
      expect(await restricted.readVaultFile({ path })).toEqual(missing);
      expect(await restricted.readVaultFrontmatter({ path })).toEqual(missing);
      expect(await restricted.getVaultFileOutline({ path })).toEqual(missing);
    }
    for (const path of [...hidden, ...readable, 'οδοσ/new.md', 'STRASSE/new.md', 'μ/new.md']) {
      expect(await restricted.createVaultFile({ path, content: 'x' })).toEqual(denied);
      expect(await restricted.updateVaultFile({ path, content: 'x', expectedRevision: '1-stale' })).toEqual(denied);
      expect(await restricted.appendVaultFile({ path, content: 'x', expectedRevision: '1-stale' })).toEqual(denied);
      expect(await restricted.patchVaultFile({ path, oldText: 'Heading', newText: 'x', expectedRevision: '1-stale' })).toEqual(denied);
      expect(await restricted.patchVaultFrontmatter({ path, updates: { status: 'x' }, expectedRevision: '1-stale' })).toEqual(denied);
      expect(await restricted.deleteVaultFile({ path, expectedRevision: '1-stale' })).toEqual(denied);
    }
    expect(data(await restricted.listVaultFiles({})).files.map((file) => file.path).sort()).toEqual(readable.sort());
    expect(data(await restricted.searchVaultFiles({ query: 'policymarker' })).results.map((file) => file.path).sort()).toEqual(readable.sort());
    const before = await stub.allDocuments(name, { include_docs: true });
    await runInDurableObject(stub, (instance: PouchDatabase) => {
      instance['ctx'].storage.sql.exec("UPDATE livesync_search_meta SET value='4' WHERE key='schema_version'");
      // Simulate the old lowercase-only key: it would miss the new sigma rule.
      instance['ctx'].storage.sql.exec("UPDATE livesync_search_documents SET policy_path='οδος/a.md' WHERE path='ΟΔΟΣ/a.md'");
    });
    expect(data(await restricted.searchVaultFiles({ query: 'policymarker' })).results.map((file) => file.path).sort()).toEqual(readable.sort());
    expect(await stub.allDocuments(name, { include_docs: true })).toEqual(before);
  });

  it('keeps SQL search visibility equal to direct policy decisions, including empty rules', async () => {
    const { stub, name } = await seeded();
    await stub.putDocument(name, { _id: 'h:parity', type: 'leaf', data: 'policymarker' });
    const paths = ['ΟΔΟΣ/a.md', 'ΟΔΟσ/a.md', 'Straße/a.md', 'STRASSE/a.md', 'Private/a.md', 'Private notes/a.md',
      'a/.hidden/a.md', '.root.md', '100%_private/a.md', "quote'/a.md", '.../a.md', ' /a.md', 'notes/_Local/a.md',
      'Café/a.md', 'Cafe\u0301/a.md', 'Journal/a.md'];
    for (const path of paths) {
      await stub.putDocument(name, { _id: path, path, type: 'plain', datatype: 'plain', children: ['h:parity'],
        size: 12, ctime: 1, mtime: 1, eden: {} });
    }
    for (const candidate of [unrestrictedPolicy, policy, vaultPathPolicySchema.parse({ rules: [
      { path: 'ΟΔΟΣ', access: 'none' }, { path: 'Straße', access: 'none' },
      { path: "quote'", access: 'none' }, { path: 'Private', access: 'read' },
    ], hideDotFolders: true })]) {
      const rpc = withVaultPathPolicy(stub, candidate);
      const expected = paths.filter((path) => pathAccess(candidate, path) !== 'none').sort();
      expect(data(await rpc.listVaultFiles({})).files.map((file) => file.path).sort()).toEqual(expected);
      expect(data(await rpc.searchVaultFiles({ query: 'policymarker' })).results.map((file) => file.path).sort()).toEqual(expected);
    }
    const open = withVaultPathPolicy(stub, unrestrictedPolicy);
    for (const path of ['.../a.md', ' /a.md', 'notes/_Local/a.md']) {
      expect(await open.readVaultFile({ path })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    }
  });

  it('filters before pagination, including attachments, properties, dot-folders and literal SQL characters', async () => {
    const { name, stub, open, restricted } = await seeded();
    const visible = ['A/a.md', 'Journal/a.md', 'Private notes/a.md', 'Z/a.md', '.root.md'];
    const hidden = ['Private/a.md', 'Private/b.md', 'Café/a.md', '100%_private/a.md', '.obsidian/a.md', 'Z/.hidden/a.md'];
    for (const path of [...visible, ...hidden]) {
      // Dot-files are ordinarily published by Obsidian, not Commonlib's create helper.
      const child = `h:${crypto.randomUUID()}`;
      const content = '---\nstatus: active\n---\npolicymarker';
      await stub.putDocument(name, { _id: child, type: 'leaf', data: content });
      await stub.putDocument(name, { _id: path, path, type: 'plain', datatype: 'plain', children: [child], size: content.length, ctime: 1, mtime: 1, eden: {} });
    }
    const listed: string[] = [];
    let cursor: string | undefined;
    do {
      const page = data(await restricted.listVaultFiles({ limit: 2, cursor }));
      listed.push(...page.files.map((file) => file.path));
      if (page.cursor) expect(page.files).toHaveLength(2);
      cursor = page.cursor;
      if (cursor) expect(atob(cursor.replaceAll('-', '+').replaceAll('_', '/'))).not.toMatch(/Private\/|Café|100%_private|\.obsidian|\.hidden/);
    } while (cursor);
    expect(listed.sort()).toEqual(visible.sort());
    expect(await restricted.listVaultFiles({ prefix: 'Private/' })).toEqual({ ok: true, data: { files: [] } });
    const found: string[] = [];
    do {
      const page = data(await restricted.searchVaultFiles({ query: 'policymarker', properties: ['status'], limit: 2, cursor }));
      expect(page.incomplete).toBe(false);
      expect(page.results.every((result) => result.properties?.status === 'active')).toBe(true);
      found.push(...page.results.map((file) => file.path));
      if (page.cursor) expect(page.results).toHaveLength(2);
      cursor = page.cursor;
    } while (cursor);
    expect(found.sort()).toEqual(visible.sort());
    expect(data(await restricted.searchVaultFiles({ query: 'policymarker', pathPrefix: 'Private/' })).results).toEqual([]);
    for (const path of ['Private/a.png', '.obsidian/a.png', 'Journal/a.png', 'Z/a.png']) await attachment(stub, name, path);
    const attachments = data(await restricted.listVaultAttachments({ limit: 1 }));
    expect(attachments.attachments.map((file) => file.path)).toEqual(['Journal/a.png']);
    expect(data(await restricted.listVaultAttachments({ cursor: attachments.cursor })).attachments.map((file) => file.path)).toEqual(['Z/a.png']);
    expect(data(await restricted.listVaultAttachments({ prefix: 'Private/' })).attachments).toEqual([]);
    expect(await restricted.listVaultFiles({ cursor: attachments.cursor })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    const root = await stub.getDocument(name, '.root.md') as JsonObject;
    await stub.putDocument(name, { ...root, _deleted: true });
    const allHidden = withVaultPathPolicy(stub, vaultPathPolicySchema.parse({ rules: [...visible.map((path) => ({ path: path.split('/')[0], access: 'none' })), ...policy.rules], hideDotFolders: true }));
    expect(data(await allHidden.listVaultFiles({}))).toEqual({ files: [] });
    expect(data(await allHidden.searchVaultFiles({ query: 'policymarker' })).results).toEqual([]);
  });

  it('binds search offsets to policy and keeps different clients isolated without rebuilding', async () => {
    const { stub, open, restricted } = await seeded();
    for (const path of ['A/a.md', 'B/b.md', 'Private/a.md']) await note(open, path);
    const first = data(await restricted.searchVaultFiles({ query: 'policymarker', limit: 1 }));
    expect(first.cursor).toBeTruthy();
    const state = () => runInDurableObject(stub, (instance: PouchDatabase) => instance['ctx'].storage.sql.exec<{ key: string; value: string }>('SELECT * FROM livesync_search_meta ORDER BY key').toArray());
    const before = await state();
    expect(await open.searchVaultFiles({ query: 'policymarker', cursor: first.cursor })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(data(await open.searchVaultFiles({ query: 'policymarker' })).results).toHaveLength(3);
    expect(data(await restricted.searchVaultFiles({ query: 'policymarker' })).results).toHaveLength(2);
    expect(await state()).toEqual(before);
    const forged = btoa(JSON.stringify({ ...JSON.parse(atob(first.cursor!)), offset: 0 }));
    expect(data(await restricted.searchVaultFiles({ query: 'policymarker', cursor: forged })).results.every((row) => !row.path.startsWith('Private/'))).toBe(true);
    const reordered = withVaultPathPolicy(stub, { ...policy, rules: [...policy.rules].reverse() });
    expect(await reordered.searchVaultFiles({ query: 'policymarker', cursor: first.cursor })).toMatchObject({ ok: true });
  });

  it('hides indexing diagnostics and pending-chunk paths, and rebuilds only derived tables', async () => {
    const { name, stub, open, restricted } = await seeded();
    await note(open, 'A/good.md');
    await note(open, 'Private/invalid.md', '---\nbroken: [\n---\npolicymarker');
    await stub.putDocument(name, { _id: 'Private/bad.md', path: 'Private/bad.md', type: 'plain', datatype: 'plain', children: 'malformed', size: 1, ctime: 1, mtime: 1 });
    const request = { query: 'policymarker', properties: ['status'] };
    const full = data(await open.searchVaultFiles(request));
    expect(full.unindexedFiles).toBeGreaterThan(0);
    expect(full.unqueryableFiles).toBeGreaterThan(0);
    expect(data(await restricted.searchVaultFiles(request))).toMatchObject({ incomplete: false, unindexedFiles: 0, unqueryableFiles: 0 });
    const before = await stub.allDocuments(name, { include_docs: true });
    await runInDurableObject(stub, (instance: PouchDatabase) => {
      instance['ctx'].storage.sql.exec("UPDATE livesync_search_meta SET value='3' WHERE key='schema_version'");
      instance['ctx'].storage.sql.exec('ALTER TABLE livesync_search_documents DROP COLUMN policy_path');
      instance['ctx'].storage.sql.exec('ALTER TABLE livesync_search_documents DROP COLUMN dot_folder');
    });
    expect(data(await restricted.searchVaultFiles(request)).results).toHaveLength(1);
    expect(await stub.allDocuments(name, { include_docs: true })).toEqual(before);
    await stub.putDocument(name, { _id: 'Private/pending.md', path: 'Private/pending.md', type: 'plain', datatype: 'plain', children: ['h:missing'], size: 1, ctime: 1, mtime: 1, eden: {} });
    const pending = await restricted.searchVaultFiles(request);
    expect(pending).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(JSON.stringify(pending)).not.toContain('Private');
  });

  it('enforces policy through real MCP serialization and rejects client-supplied policy', async () => {
    const { stub, open, restricted } = await seeded();
    await note(open, 'Private/a.md');
    await note(open, 'Journal/a.md');
    const server = createVaultMcpServer(restricted, { canRead: () => true, canWrite: () => true, writesEnabled: true });
    const client = new Client({ name: 'policy-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(a), client.connect(b)]);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(VAULT_TOOL_NAMES);
      expect(await client.callTool({ name: 'read_files', arguments: { files: [{ path: 'Private/a.md' }, { path: 'Journal/a.md' }] } })).toMatchObject({ structuredContent: { files: [
        { result: missing }, { result: { ok: true } },
      ] } });
      expect(await client.callTool({ name: 'create_file', arguments: { path: 'Private/new.md', content: 'x' } })).toMatchObject({ isError: true, structuredContent: { error: denied.error } });
      expect(await client.callTool({ name: 'read_file', arguments: { path: 'Private/a.md', pathPolicy: unrestrictedPolicy } })).toMatchObject({ isError: true });
      expect(await client.callTool({ name: 'read_file', arguments: { path: 'Private/a.md' } })).toMatchObject({ isError: true, structuredContent: { error: missing.error } });
    } finally { await Promise.all([client.close(), server.close()]); }
    // Deliberately malformed wire calls: absence of trusted context never means unrestricted.
    // @ts-expect-error missing RPC envelope
    expect(await stub.readVaultFile({ path: 'Private/a.md' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    // @ts-expect-error missing path policy
    expect(await stub.createVaultFile({ request: { path: 'A/new.md', content: 'x' } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(await open.readVaultFile({ path: 'A/new.md' })).toEqual(missing);
  });

  it('fails closed on inconsistent stored paths before returning content or reconciling', async () => {
    const { name, stub, open, restricted } = await seeded();
    await note(open, 'A/a.md');
    const original = await stub.getDocument(name, 'A/a.md') as JsonObject;
    await stub.putDocument(name, { ...original, path: 'Private/a.md' });
    const before = await stub.getDocument(name, 'A/a.md') as JsonObject;
    expect(await restricted.readVaultFile({ path: 'A/a.md' })).toEqual(missing);
    expect(await restricted.readVaultFrontmatter({ path: 'A/a.md' })).toEqual(missing);
    expect(await restricted.getVaultFileOutline({ path: 'A/a.md' })).toEqual(missing);
    expect(await restricted.createVaultFile({ path: 'A/a.md', content: 'x' })).toEqual(denied);
    expect(await restricted.updateVaultFile({ path: 'A/a.md', expectedRevision: '1-stale', content: 'x' })).toEqual(denied);
    expect(await restricted.patchVaultFile({ path: 'A/a.md', expectedRevision: '1-stale', oldText: 'Heading', newText: 'x' })).toEqual(denied);
    expect(await restricted.patchVaultFrontmatter({ path: 'A/a.md', expectedRevision: '1-stale', updates: { status: 'x' } })).toEqual(denied);
    expect(await restricted.deleteVaultFile({ path: 'A/a.md', expectedRevision: '1-stale' })).toEqual(denied);
    expect(await restricted.appendVaultFile({ path: 'A/a.md', expectedRevision: before._rev as string, content: 'changed' })).toEqual(denied);
    expect(await stub.getDocument(name, 'A/a.md')).toEqual(before);
  });

  it('checks losing conflict revisions before merging and preserves fixed write denials', async () => {
    const { stub, path, tree } = await conflictVault({ storedPaths: ['Private/secret.md', 'notes/conflict.md'] });
    const before = await tree();
    const rpc = withVaultPathPolicy(stub, policy);
    expect(await rpc.appendVaultFile({ path, expectedRevision: '2-b', content: 'changed' })).toEqual(denied);
    expect(await tree()).toEqual(before);
  });

  it('checks identity within each existing metadata read without an extra fetch', async () => {
    const { name, stub, open } = await seeded();
    await note(open, 'A/a.md');
    await runInDurableObject(stub, async (instance: PouchDatabase) => {
      const profile = await instance['inspectCommonlibProfile']();
      const facade = new CommonlibFacade(name, instance['inProcessCouchFetch'](), profile, 'not_found');
      await facade.ready();
      const spy = vi.spyOn(facade['manipulator'].liveSyncLocalDB, 'getRaw');
      try {
        const vault = new LiveSyncVault({ profile: async () => profile, acquireCommonlib: async () => facade }, policy);
        expect(data(await vault.read({ path: 'A/a.md' })).content).toContain('policymarker');
        expect(spy.mock.calls.filter(([id]) => id === 'A/a.md')).toHaveLength(2);
      } finally { spy.mockRestore(); await facade.close(); }
    });
  });

  it('leaves standard CouchDB writes and replication of restricted files unchanged', async () => {
    const source = await seeded();
    const target = await seeded();
    const remote = (name: string) => new ReplicationPouch<JsonObject>(`https://policy.test/${name}`, {
      adapter: 'http', auth: { username: 'admin', password: 'test-password' },
      fetch: (input: RequestInfo | URL, init?: RequestInit) => SELF.fetch(new Request(input, init)),
    } as PouchDB.Configuration.RemoteDatabaseConfiguration);
    await note(source.open, 'Private/a.md');
    await note(source.open, 'Journal/a.md');
    const from = remote(source.name);
    const to = remote(target.name);
    try {
      await attachment(source.stub, source.name, 'Private/a.png');
      expect((await ReplicationPouch.replicate(from, to)).ok).toBe(true);
      for (const path of ['Private/a.md', 'Journal/a.md', 'Private/a.png']) expect(await to.get(path)).toEqual(await from.get(path));
      const original = await from.get('Private/a.md');
      await from.put({ ...original, mtime: 99 });
      expect((await ReplicationPouch.replicate(from, to)).ok).toBe(true);
      expect((await to.get('Private/a.md')).mtime).toBe(99);
      expect(await target.restricted.readVaultFile({ path: 'Private/a.md' })).toEqual(missing);
      expect(await target.restricted.appendVaultFile({ path: 'Journal/a.md', expectedRevision: '1-stale', content: 'x' })).toEqual(denied);
      expect(data(await target.open.readVaultAttachment({ path: 'Private/a.png' })).contentBase64).toBe('AQID');
    } finally { await Promise.all([from.close(), to.close()]); }
  });
});
