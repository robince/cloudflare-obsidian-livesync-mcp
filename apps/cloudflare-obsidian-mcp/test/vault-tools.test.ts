import { describe, expect, it, vi } from 'vitest';
import { VAULT_LIMITS } from '@cloudflare-obsidian-livesync/contracts';

import { allowedGithubLogins, normalizeGithubLogin } from '../src/auth-utils';
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
  WRITE_SCOPE,
  VAULT_TOOL_NAMES,
} from '../src/vault-tools';
import { isVaultDatabaseName, VAULT_DATABASE_NAME, vaultRpcForEnv } from '../src/vault-rpc';
import type { VaultRpc } from '../src/vault-rpc';

const fakeRpc: VaultRpc = {
  async vaultStatus() {
    return { ok: true, data: { contractVersion: 3, compatible: true, reasons: [] } };
  },
  async listVaultFiles() {
    return { ok: true, data: { files: [{ path: 'notes/a.md', revision: '1-a', sizeBytes: 4, modifiedAt: 2 }] } };
  },
  async listVaultAttachments() {
    return { ok: true, data: { attachments: [{ path: 'assets/a.png', revision: '1-png', mimeType: 'image/png', sizeBytes: 3 }] } };
  },
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
      'read_file',
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
    const disabled = createVaultMcpServer(fakeRpc, { writesEnabled: false });
    const enabled = createVaultMcpServer(fakeRpc, { writesEnabled: true });
    const registered = (server: unknown) => Object.keys((server as { _registeredTools: object })._registeredTools);
    expect(registered(disabled)).toEqual([
      'vault_status', 'list_files', 'read_file', 'read_frontmatter', 'list_attachments', 'read_attachment',
    ]);
    expect(registered(enabled)).toEqual(VAULT_TOOL_NAMES);
  });

  it('does not accept a database selector in tool input', () => {
    expect(listFilesInput.safeParse({ database: 'another-vault' }).success).toBe(false);
    expect(readFileInput.safeParse({ path: 'notes/a.md', database: 'another-vault' }).success).toBe(false);
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
      structuredContent: { contractVersion: 3, compatible: true },
    });
    await expect(allowed.listFiles({})).resolves.toMatchObject({
      structuredContent: { files: [{ path: 'notes/a.md' }] },
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
    expect(() => createVaultMcpServer(fakeRpc, { allowedLogins: new Set(['robince']) })).not.toThrow();
    const handlers = createVaultToolHandlers(fakeRpc, { allowedLogins: new Set(['robince']) });
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
    expect(allowedGithubLogins(undefined).size).toBe(0);
    expect(allowedGithubLogins('')).toEqual(new Set());
    expect(allowedGithubLogins('RobinCE, OTHER\nthird')).toEqual(new Set(['robince', 'other', 'third']));
  });

  it('re-checks the allowlist at tool execution', () => {
    const props = { githubLogin: 'robince', scopes: ['vault:read'] };
    expect(hasVaultAccess(props, new Set(['robince']))).toBe(true);
    expect(hasVaultAccess(props, new Set())).toBe(false);
    expect(hasVaultAccess({ githubLogin: 'robince', scopes: [] }, new Set(['robince']))).toBe(false);
    expect(hasVaultAccess(props, new Set(['robince']), WRITE_SCOPE)).toBe(false);
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
