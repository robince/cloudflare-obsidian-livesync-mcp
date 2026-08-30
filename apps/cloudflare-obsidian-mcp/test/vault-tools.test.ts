import { describe, expect, it } from 'vitest';

import { allowedGithubLogins, normalizeGithubLogin } from '../src/auth-utils';
import {
  createVaultToolHandlers,
  hasReadScope,
  listFilesInput,
  readFileInput,
  VAULT_TOOL_NAMES,
} from '../src/vault-tools';
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
};

describe('read-only MCP surface', () => {
  it('registers only the three read-only vault tools', () => {
    expect(VAULT_TOOL_NAMES).toEqual(['vault_status', 'list_files', 'read_file']);
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

    const denied = createVaultToolHandlers(fakeRpc, () => false);
    await expect(denied.readFile({ path: 'notes/a.md' })).resolves.toMatchObject({ isError: true });
  });
});

describe('GitHub allowlist', () => {
  it('normalizes logins and remains deny-by-default', () => {
    expect(normalizeGithubLogin('  RobinCE  ')).toBe('robince');
    expect(allowedGithubLogins(undefined).size).toBe(0);
    expect(allowedGithubLogins('RobinCE, OTHER\nthird')).toEqual(new Set(['robince', 'other', 'third']));
  });
});
