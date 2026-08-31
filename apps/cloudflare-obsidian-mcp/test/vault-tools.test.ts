import { describe, expect, it } from 'vitest';

import { allowedGithubLogins, normalizeGithubLogin } from '../src/auth-utils';
import {
  accessTokenScopes,
  createVaultMcpServer,
  createVaultToolHandlers,
  hasReadScope,
  hasVaultAccess,
  listFilesInput,
  readFileInput,
  WRITE_SCOPE,
  VAULT_TOOL_NAMES,
} from '../src/vault-tools';
import { isVaultDatabaseName, VAULT_DATABASE_NAME } from '../src/vault-rpc';
import type { VaultRpc } from '../src/vault-rpc';

const fakeRpc: VaultRpc = {
  async vaultStatus() {
    return { ok: true, data: { contractVersion: 1, compatible: true, reasons: [] } };
  },
  async listVaultFiles() {
    return { ok: true, data: { files: [{ path: 'notes/a.md', revision: '1-a' }] } };
  },
  async readVaultFile({ path }) {
    return { ok: true, data: { path, revision: '1-a', content: '# A\n' } };
  },
  async createVaultFile({ path }) {
    return { ok: true, data: { path, revision: '1-new' } };
  },
  async updateVaultFile({ path }) {
    return { ok: true, data: { path, revision: '2-edit' } };
  },
  async deleteVaultFile({ path }) {
    return { ok: true, data: { path, revision: '2-del' } };
  },
  async moveVaultFile({ from, to }) {
    return { ok: true, data: { from, to, revision: '2-move' } };
  },
};

describe('MCP vault surface', () => {
  it('registers the vault tools', () => {
    expect(VAULT_TOOL_NAMES).toEqual([
      'vault_status',
      'list_files',
      'read_file',
      'create_file',
      'edit_file',
      'delete_file',
      'move_file',
    ]);
  });

  it('does not accept a database selector in tool input', () => {
    expect(listFilesInput.safeParse({ database: 'another-vault' }).success).toBe(false);
    expect(readFileInput.safeParse({ path: 'notes/a.md', database: 'another-vault' }).success).toBe(false);
  });

  it('requires vault:read regardless of other props', () => {
    expect(hasReadScope(undefined)).toBe(false);
    expect(hasReadScope({ scopes: [] })).toBe(false);
    expect(hasReadScope({ scopes: ['vault:write'] })).toBe(false);
    expect(hasReadScope({ scopes: ['vault:read'] })).toBe(true);
  });

  it('executes the real handlers against a fake read-only RPC', async () => {
    const allowed = createVaultToolHandlers(fakeRpc, () => true);
    await expect(allowed.vaultStatus()).resolves.toMatchObject({
      structuredContent: { contractVersion: 1, compatible: true },
    });
    await expect(allowed.listFiles({})).resolves.toMatchObject({
      structuredContent: { files: [{ path: 'notes/a.md' }] },
    });
    await expect(allowed.readFile({ path: 'notes/a.md' })).resolves.toMatchObject({
      structuredContent: { content: '# A\n' },
    });
    await expect(allowed.createFile({ path: 'notes/b.md', content: '# B\n' })).resolves.toMatchObject({
      structuredContent: { path: 'notes/b.md', revision: '1-new' },
    });

    const denied = createVaultToolHandlers(fakeRpc, () => false);
    await expect(denied.readFile({ path: 'notes/a.md' })).resolves.toMatchObject({ isError: true });

    const readOnly = createVaultToolHandlers(fakeRpc, { canRead: () => true, canWrite: () => false });
    await expect(readOnly.createFile({ path: 'notes/b.md', content: '# B\n' })).resolves.toMatchObject({ isError: true });
    await expect(readOnly.editFile({ path: 'notes/a.md', content: '# A\n', expectedRevision: '1-a' })).resolves.toMatchObject({ isError: true });
    await expect(readOnly.deleteFile({ path: 'notes/a.md', expectedRevision: '1-a' })).resolves.toMatchObject({ isError: true });
    await expect(readOnly.moveFile({ from: 'notes/a.md', to: 'notes/c.md', expectedRevision: '1-a' })).resolves.toMatchObject({ isError: true });
  });

  it('registers tools and denies the default auth context', async () => {
    expect(() => createVaultMcpServer(fakeRpc, { allowedLogins: new Set(['robince']) })).not.toThrow();
    const handlers = createVaultToolHandlers(fakeRpc, { allowedLogins: new Set(['robince']) });
    await expect(handlers.vaultStatus()).resolves.toMatchObject({ isError: true });
  });

  it('omits structured content on vault errors', async () => {
    const failing: VaultRpc = {
      ...fakeRpc,
      async readVaultFile() {
        return { ok: false, error: { code: 'not_found', message: 'File not found.' } };
      },
    };
    const handlers = createVaultToolHandlers(failing, () => true);
    const result = await handlers.readFile({ path: 'notes/missing.md' });
    expect(result).toMatchObject({ isError: true });
    expect(result).not.toHaveProperty('structuredContent');
  });

  it('rejects a VAULT_DATABASE that LiveSync could not have created', () => {
    expect(VAULT_DATABASE_NAME.test('vault')).toBe(true);
    expect(VAULT_DATABASE_NAME.test('Vault')).toBe(false);
    expect(VAULT_DATABASE_NAME.test('')).toBe(false);
    expect(isVaultDatabaseName(undefined)).toBe(false);
    expect(isVaultDatabaseName('undefined')).toBe(true);
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
  });
});
