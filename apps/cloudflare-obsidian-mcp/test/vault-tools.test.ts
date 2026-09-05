import { describe, expect, it, vi } from 'vitest';
import { VAULT_LIMITS } from '@cloudflare-obsidian-livesync/contracts';

import { allowedGithubUserIds, normalizeGithubLogin } from '../src/auth-utils';
import {
  accessTokenScopes,
  appendFileInput,
  createVaultMcpServer,
  createVaultToolHandlers,
  createFileInput,
  hasReadScope,
  hasVaultAccess,
  listFilesInput,
  patchFrontmatterInput,
  readFileInput,
  readFilesInput,
  MAX_BATCH_RESPONSE_BYTES,
  searchFilesInput,
  WRITE_SCOPE,
  VAULT_TOOL_NAMES,
} from '../src/vault-tools';
import { isVaultDatabaseName, VAULT_DATABASE_NAME, vaultRpcForEnv } from '../src/vault-rpc';
import type { VaultRpc } from '../src/vault-rpc';

const fakeRpc: VaultRpc = {
  async vaultStatus() {
    return { ok: true, data: { contractVersion: 5, compatible: true, reasons: [] } };
  },
  async listVaultFiles() {
    return { ok: true, data: { files: [{ path: 'notes/a.md', revision: '1-a', sizeBytes: 4, modifiedAt: 2 }] } };
  },
  async searchVaultFiles() {
    return {
      ok: true,
      data: {
        results: [{ path: 'notes/a.md', revision: '1-a', snippet: '# ⟦A⟧\n' }],
        truncated: false,
        incomplete: false,
        unindexedFiles: 0,
      },
    };
  },
  async listVaultAttachments() {
    return { ok: true, data: { attachments: [{ path: 'assets/a.png', revision: '1-png', mimeType: 'image/png', sizeBytes: 3 }] } };
  },
  async getVaultFileOutline({ path }) { return { ok: true, data: { path, revision: '1-a', totalLines: 1, headings: [] } }; },
  async readVaultFile({ path }) {
    return { ok: true, data: { path, revision: '1-a', content: '# A\n' } };
  },
  async readVaultAttachment({ path }) {
    return { ok: true, data: { path, revision: '1-png', mimeType: 'image/png', sizeBytes: 3, contentBase64: 'AQID' } };
  },
  async readVaultFrontmatter({ path }) {
    return { ok: true, data: { path, revision: '1-a', frontmatter: { tags: ['test'] } } };
  },
  async createVaultFile({ path }) {
    return { ok: true, data: { path, revision: '1-new' } };
  },
  async updateVaultFile({ path }) {
    return { ok: true, data: { path, revision: '2-edit' } };
  },
  async appendVaultFile({ path }) {
    return { ok: true, data: { path, revision: '2-append' } };
  },
  async patchVaultFile({ path }) {
    return { ok: true, data: { path, revision: '2-patch', replacements: 1 } };
  },
  async patchVaultFrontmatter({ path }) {
    return { ok: true, data: { path, revision: '2-frontmatter', updated: ['status'], removed: [] } };
  },
  async deleteVaultFile({ path }) {
    return { ok: true, data: { path, revision: '2-del' } };
  },
};

describe('MCP vault surface', () => {
  it('registers the vault tools', () => {
    expect(VAULT_TOOL_NAMES).toEqual([
      'vault_status',
      'list_files',
      'search_files',
      'read_file',
      'read_files',
      'get_file_outline',
      'read_frontmatter',
      'list_attachments',
      'read_attachment',
      'create_file',
      'edit_file',
      'append_file',
      'patch_file',
      'patch_frontmatter',
      'delete_file',
    ]);
    const disabled = createVaultMcpServer(fakeRpc, { writesEnabled: false, canRead: () => true });
    const enabled = createVaultMcpServer(fakeRpc, { writesEnabled: true, canRead: () => true, canWrite: () => true });
    const registered = (server: unknown) => Object.keys((server as { _registeredTools: object })._registeredTools);
    expect(registered(disabled)).toEqual([
      'vault_status', 'list_files', 'search_files', 'read_file', 'read_files', 'get_file_outline', 'read_frontmatter', 'list_attachments', 'read_attachment',
    ]);
    expect(registered(enabled)).toEqual(VAULT_TOOL_NAMES);
  });


  it('advertises only effective permissions and rechecks handlers after revocation', async () => {
    let permitted = true;
    const registered = (server: unknown) => Object.keys((server as { _registeredTools: object })._registeredTools);
    const readOnly = createVaultMcpServer(fakeRpc, { writesEnabled: true, canRead: () => true, canWrite: () => false });
    expect(registered(readOnly)).toContain('read_files');
    expect(registered(readOnly)).not.toContain('create_file');
    expect(registered(createVaultMcpServer(fakeRpc, { writesEnabled: true, canRead: () => false, canWrite: () => true }))).toEqual([]);
    const read = vi.fn(fakeRpc.readVaultFile);
    const handlers = createVaultToolHandlers({ ...fakeRpc, readVaultFile: read }, { canRead: () => permitted });
    permitted = false;
    expect(await handlers.readFiles({ files: [{ path: 'a.md' }] })).toMatchObject({ isError: true });
    expect(read).not.toHaveBeenCalled();
  });

  it('bounds batch input and preserves per-item failures, ranges and revisions', async () => {
    expect(readFilesInput.safeParse({ files: [] }).success).toBe(false);
    expect(readFilesInput.safeParse({ files: Array(11).fill({ path: 'a.md' }) }).success).toBe(false);
    expect(readFilesInput.safeParse({ files: [{ path: 'a.md', database: 'other' }] }).success).toBe(false);
    expect(readFilesInput.safeParse({ files: [{ path: 'a.md', startLine: 3, endLine: 2 }] }).success).toBe(false);
    const read = vi.fn<VaultRpc['readVaultFile']>(async (request) => {
      if (request.path === 'missing.md') return { ok: false, error: { code: 'not_found', message: 'Missing' } };
      if (request.path === 'throw.md') throw new Error('private transport details');
      if (request.expectedRevision === 'stale') return { ok: false, error: { code: 'revision_conflict', message: 'Reread', path: request.path, resolution: 'reread_and_reassess' } };
      return { ok: true, data: { path: request.path, revision: '2-a', content: '雪\r\n', startLine: 2, endLine: 2, totalLines: 3, partial: true } };
    });
    const handlers = createVaultToolHandlers({ ...fakeRpc, readVaultFile: read }, { canRead: () => true });
    const files = [{ path: 'missing.md' }, { path: 'throw.md' }, { path: 'a.md', expectedRevision: 'stale' }, { path: 'a.md', startLine: 2, endLine: 2, expectedRevision: '2-a' }];
    const response = await handlers.readFiles({ files });
    expect(response).toMatchObject({ structuredContent: { files: [
      { index: 0, result: { ok: false, error: { code: 'not_found' } } },
      { index: 1, result: { ok: false, error: { code: 'internal' } } },
      { index: 2, result: { ok: false, error: { code: 'revision_conflict' } } },
      { index: 3, result: { ok: true, data: { content: '雪\r\n', revision: '2-a', partial: true } } },
    ] } });
    expect(read).toHaveBeenLastCalledWith(files[3]);
    expect(JSON.stringify(response)).not.toContain('private transport details');
    expect(JSON.parse(response.content[0].text)).toEqual('structuredContent' in response && response.structuredContent);
    read.mockClear();
    expect(await handlers.readFiles({ files: [] })).toMatchObject({ isError: true });
    expect(read).not.toHaveBeenCalled();
  });

  it('caps serialized batch bytes including escaped text duplication without hiding later small files', async () => {
    const read: VaultRpc['readVaultFile'] = async ({ path }) => ({ ok: true, data: {
      path, revision: '1-a', content: path === 'large.md' ? '\u0000'.repeat(200_000) : '雪'.repeat(50_000),
    } });
    const handlers = createVaultToolHandlers({ ...fakeRpc, readVaultFile: read }, { canRead: () => true });
    const response = await handlers.readFiles({ files: [{ path: 'large.md' }, ...Array(9).fill({ path: 'small.md' })] });
    expect(new TextEncoder().encode(JSON.stringify(response)).byteLength).toBeLessThanOrEqual(MAX_BATCH_RESPONSE_BYTES);
    expect(response).toMatchObject({ structuredContent: { files: [
      { index: 0, result: { omitted: true, reason: 'response_budget' } },
      { index: 1, result: { ok: true } },
      ...Array.from({ length: 8 }, (_, i) => ({ index: i + 2 })),
    ] } });
  });

  it('does not accept a database selector in tool input', () => {
    expect(listFilesInput.safeParse({ database: 'another-vault' }).success).toBe(false);
    expect(readFileInput.safeParse({ path: 'notes/a.md', database: 'another-vault' }).success).toBe(false);
    expect(searchFilesInput.safeParse({ query: 'a', database: 'another-vault' }).success).toBe(false);
  });

  it('bounds and treats search input as plain text', () => {
    expect(searchFilesInput.safeParse({ query: 'hello world', pathPrefix: 'notes/', limit: 50 }).success).toBe(true);
    expect(searchFilesInput.safeParse({ query: '   ' }).success).toBe(false);
    expect(searchFilesInput.safeParse({ query: 'é'.repeat(129) }).success).toBe(false);
    expect(searchFilesInput.safeParse({ query: Array.from({ length: 17 }, (_, index) => `t${index}`).join(' ') }).success).toBe(false);
  });

  it('enforces write limits in UTF-8 bytes', () => {
    expect(createFileInput.safeParse({
      path: 'notes/large.md',
      content: 'é'.repeat(256_001),
    }).success).toBe(false);
    expect(appendFileInput.safeParse({
      path: 'notes/a.md', content: '', expectedRevision: '1-a',
    }).success).toBe(false);
    expect(patchFrontmatterInput.safeParse({
      path: 'notes/a.md', updates: {}, expectedRevision: '1-a',
    }).success).toBe(false);

    expect(patchFrontmatterInput.safeParse({
      path: 'notes/a.md',
      updates: { large: 'x'.repeat(VAULT_LIMITS.maxFrontmatterBytes) },
      expectedRevision: '1-a',
    }).success).toBe(false);

    let nested: Record<string, unknown> = { value: true };
    for (let depth = 0; depth <= VAULT_LIMITS.maxFrontmatterDepth; depth++) nested = { nested };
    expect(patchFrontmatterInput.safeParse({
      path: 'notes/a.md', updates: nested, expectedRevision: '1-a',
    }).success).toBe(false);

    expect(patchFrontmatterInput.safeParse({
      path: 'notes/a.md',
      updates: { values: Array.from({ length: VAULT_LIMITS.maxFrontmatterNodes }, () => null) },
      expectedRevision: '1-a',
    }).success).toBe(false);
  });

  it('requires vault:read regardless of other props', () => {
    expect(hasReadScope(undefined)).toBe(false);
    expect(hasReadScope({ scopes: [] })).toBe(false);
    expect(hasReadScope({ scopes: ['vault:write'] })).toBe(false);
    expect(hasReadScope({ scopes: ['vault:read'] })).toBe(true);
  });

  it('executes the real handlers against a fake RPC', async () => {
    const allowed = createVaultToolHandlers(fakeRpc, {
      writesEnabled: true,
      canRead: () => true,
      canWrite: () => true,
    });
    await expect(allowed.vaultStatus()).resolves.toMatchObject({
      structuredContent: { contractVersion: 5, compatible: true },
    });
    await expect(allowed.listFiles({})).resolves.toMatchObject({
      structuredContent: { files: [{ path: 'notes/a.md' }] },
    });
    await expect(allowed.searchFiles({ query: 'A' })).resolves.toMatchObject({
      structuredContent: { results: [{ path: 'notes/a.md' }], incomplete: false },
    });
    await expect(allowed.readFile({ path: 'notes/a.md' })).resolves.toMatchObject({
      structuredContent: { content: '# A\n' },
    });
    await expect(allowed.readFrontmatter({ path: 'notes/a.md' })).resolves.toMatchObject({
      structuredContent: { frontmatter: { tags: ['test'] } },
    });
    await expect(allowed.listAttachments({})).resolves.toMatchObject({
      structuredContent: { attachments: [{ path: 'assets/a.png' }] },
    });
    await expect(allowed.readAttachment({ path: 'assets/a.png' })).resolves.toMatchObject({
      structuredContent: { contentBase64: 'AQID' },
    });
    await expect(allowed.createFile({ path: 'notes/b.md', content: '# B\n' })).resolves.toMatchObject({
      structuredContent: { path: 'notes/b.md', revision: '1-new' },
    });

    const denied = createVaultToolHandlers(fakeRpc, { canRead: () => false });
    await expect(denied.searchFiles({ query: 'A' })).resolves.toMatchObject({ isError: true });
    await expect(denied.readFile({ path: 'notes/a.md' })).resolves.toMatchObject({ isError: true });

    const readOnly = createVaultToolHandlers(fakeRpc, {
      writesEnabled: true,
      canRead: () => true,
      canWrite: () => false,
    });
    await expect(readOnly.createFile({ path: 'notes/b.md', content: '# B\n' })).resolves.toMatchObject({ isError: true });
    await expect(readOnly.editFile({ path: 'notes/a.md', content: '# A\n', expectedRevision: '1-a' })).resolves.toMatchObject({ isError: true });
    await expect(readOnly.appendFile({ path: 'notes/a.md', content: 'x', expectedRevision: '1-a' })).resolves.toMatchObject({ isError: true });
    await expect(readOnly.patchFile({ path: 'notes/a.md', oldText: 'A', newText: 'B', expectedRevision: '1-a' })).resolves.toMatchObject({ isError: true });
    await expect(readOnly.patchFrontmatter({ path: 'notes/a.md', updates: {}, expectedRevision: '1-a' })).resolves.toMatchObject({ isError: true });
    await expect(readOnly.deleteFile({ path: 'notes/a.md', expectedRevision: '1-a' })).resolves.toMatchObject({ isError: true });

    const disabled = createVaultToolHandlers(fakeRpc, {
      writesEnabled: false,
      canRead: () => true,
      canWrite: () => true,
    });
    await expect(disabled.createFile({ path: 'notes/b.md', content: '# B\n' })).resolves.toMatchObject({ isError: true });

    const writeOnly = createVaultToolHandlers(fakeRpc, {
      writesEnabled: true,
      canRead: () => false,
      canWrite: () => true,
    });
    await expect(writeOnly.createFile({ path: 'notes/b.md', content: '# B\n' })).resolves.toMatchObject({ isError: true });
  });

  it('registers tools and denies the default auth context', async () => {
    expect(() => createVaultMcpServer(fakeRpc, { allowedUserIds: new Set(['12345']) })).not.toThrow();
    const handlers = createVaultToolHandlers(fakeRpc, { allowedUserIds: new Set(['12345']) });
    await expect(handlers.vaultStatus()).resolves.toMatchObject({ isError: true });
  });

  it('preserves structured content on vault errors', async () => {
    const failing: VaultRpc = {
      ...fakeRpc,
      async readVaultFile() {
        return { ok: false, error: { code: 'not_found', message: 'File not found.' } };
      },
    };
    const handlers = createVaultToolHandlers(failing, { canRead: () => true });
    const result = await handlers.readFile({ path: 'notes/missing.md' });
    expect(result).toMatchObject({ isError: true });
    expect(result).toMatchObject({ structuredContent: { error: { code: 'not_found' } } });
  });

  it('rejects a VAULT_DATABASE that LiveSync could not have created', () => {
    expect(VAULT_DATABASE_NAME.test('vault')).toBe(true);
    expect(VAULT_DATABASE_NAME.test('Vault')).toBe(false);
    expect(VAULT_DATABASE_NAME.test('')).toBe(false);
    expect(isVaultDatabaseName(undefined)).toBe(false);
    expect(isVaultDatabaseName('undefined')).toBe(true);
  });

  it('fails closed before selecting a Durable Object for an invalid VAULT_DATABASE', async () => {
    const getByName = vi.fn();
    const rpc = vaultRpcForEnv({ VAULT_DATABASE: 'bad/name', POUCH_DATABASES: { getByName } });
    await expect(rpc.vaultStatus()).resolves.toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
    expect(getByName).not.toHaveBeenCalled();
  });
});

describe('GitHub allowlist', () => {
  it('normalizes logins and remains deny-by-default', () => {
    expect(normalizeGithubLogin('  RobinCE  ')).toBe('robince');
    expect(allowedGithubUserIds(undefined).size).toBe(0);
    expect(allowedGithubUserIds('')).toEqual(new Set());
    expect(allowedGithubUserIds('12345, 67890\n23456')).toEqual(new Set(['12345', '67890', '23456']));
    expect(allowedGithubUserIds('12345, robince').size).toBe(0);
    expect(allowedGithubUserIds('0').size).toBe(0);
    expect(allowedGithubUserIds('99999999999999999999').size).toBe(0);
  });

  it('re-checks the allowlist at tool execution', () => {
    const props = { githubUserId: '12345', githubLogin: 'robince', scopes: ['vault:read'] };
    expect(hasVaultAccess(props, new Set(['12345']))).toBe(true);
    expect(hasVaultAccess(props, new Set())).toBe(false);
    expect(hasVaultAccess({ ...props, githubUserId: '67890' }, new Set(['12345']))).toBe(false);
    expect(hasVaultAccess({ ...props, githubLogin: 'renamed' }, new Set(['12345']))).toBe(true);
    expect(hasVaultAccess({ githubLogin: 'robince', scopes: ['vault:read'] }, new Set(['12345']))).toBe(false);
    expect(hasVaultAccess({ githubLogin: 'robince', scopes: [] }, new Set(['12345']))).toBe(false);
    expect(hasVaultAccess(props, new Set(['12345']), WRITE_SCOPE)).toBe(false);
  });

  it('does not let a read-only token exchange keep write scope', () => {
    const grant = { scopes: ['vault:read', 'vault:write'] };
    expect(accessTokenScopes(grant, ['vault:read'])).toEqual(['vault:read']);
    expect(accessTokenScopes(grant, ['vault:read', 'vault:write'])).toEqual(['vault:read', 'vault:write']);
    expect(accessTokenScopes(grant, undefined)).toEqual(['vault:read', 'vault:write']);
    expect(accessTokenScopes(grant, [])).toEqual([]);
    expect(accessTokenScopes(grant, ['unknown'])).toEqual([]);
  });
});


describe('MCP result and query contracts', () => {
  it('returns text fallback data and accurate annotations', async () => {
    const handlers = createVaultToolHandlers(fakeRpc, { canRead: () => true });
    const result = await handlers.readFile({ path: 'notes/a.md' });
    expect(result).toHaveProperty('structuredContent');
    if ('structuredContent' in result) expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    const server = createVaultMcpServer(fakeRpc, { writesEnabled: true, canRead: () => true, canWrite: () => true });
    const tools = (server as unknown as { _registeredTools: Record<string, { annotations: object }> })._registeredTools;
    expect(tools.get_file_outline.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tools.create_file.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(tools.append_file.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(tools.edit_file.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
  });

  it('rejects expressions, coercion and invalid ISO dates at the query boundary', () => {
    for (const filter of [
      { property: 'due', operator: 'lt', type: 'date', value: '2026-02-30' },
      { property: 'n', operator: 'lt', type: 'number', value: '10' },
      { property: 'n', operator: 'regex', value: '*' },
      { property: 'n', operator: 'exists', value: 'true' },
    ]) expect(searchFilesInput.safeParse({ filters: [filter] }).success).toBe(false);
    expect(searchFilesInput.safeParse({ filters: [] }).success).toBe(false);
    expect(searchFilesInput.safeParse({ filters: [{ property: 'status', operator: 'eq', value: 'open' }] }).success).toBe(true);
  });
});
