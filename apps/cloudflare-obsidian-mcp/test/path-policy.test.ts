import { describe, expect, it, vi } from 'vitest';
import { PATH_POLICY_LIMITS, pathAccess, policyPathKey, vaultPathPolicySchema } from '@cloudflare-obsidian-livesync/contracts';
import { pathPolicyForEnv, PathPolicyConfigurationError } from '../src/path-policy';
import { withVaultPathPolicy, type StorageVaultRpc } from '../src/vault-rpc';

const rules = [{ path: 'Private/', access: 'none' }, { path: 'Journal/', access: 'read' }];

describe('MCP path policy configuration', () => {
  it('accepts JSON bindings and text, normalizes rules, and makes order irrelevant', () => {
    const array = pathPolicyForEnv({ MCP_PATH_RULES: rules });
    const text = pathPolicyForEnv({ MCP_PATH_RULES: JSON.stringify([...rules].reverse()) });
    expect(array).toEqual(text);
    expect(pathAccess(array, 'PRIVATE/new.md')).toBe('none');
    expect(pathAccess(array, 'journal/new.md')).toBe('read');
    expect(pathAccess(array, 'Private notes/new.md')).toBe('write');
    expect(pathAccess(array, 'New/new.md')).toBe('write');
    expect(pathPolicyForEnv({ MCP_PATH_RULES: [] }).rules).toEqual([]);
    const boundary = pathPolicyForEnv({ MCP_PATH_RULES: [{ path: 'a'.repeat(1023), access: 'none' }] });
    expect(vaultPathPolicySchema.parse(boundary)).toEqual(boundary);
  });

  it('fails closed and logs only variable names, once per invalid variable', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const value of [undefined, '', 'not JSON', {}, [{ path: 'secret', access: 'write' }],
        [{ path: 'secret', access: 'none', extra: 'secret' }],
        ' '.repeat(PATH_POLICY_LIMITS.maxConfigBytes + 1),
        Array.from({ length: PATH_POLICY_LIMITS.maxRules + 1 }, () => rules[0])]) {
        expect(() => pathPolicyForEnv({ MCP_PATH_RULES: value })).toThrow(PathPolicyConfigurationError);
      }
      expect(() => pathPolicyForEnv({ MCP_PATH_RULES: [], MCP_HIDE_DOT_FOLDERS: true })).toThrow(PathPolicyConfigurationError);
      expect(log.mock.calls).toEqual([
        [{ event: 'mcp_configuration_error', variable: 'MCP_PATH_RULES' }],
        [{ event: 'mcp_configuration_error', variable: 'MCP_HIDE_DOT_FOLDERS' }],
      ]);
    } finally { log.mockRestore(); }
  });

  it('normalizes Unicode and trailing dots/spaces without changing stored path spelling', () => {
    const policy = pathPolicyForEnv({ MCP_PATH_RULES: [
      { path: '/./PrivaTÉ. /', access: 'none' }, { path: 'Journal', access: 'read' },
      { path: 'Journal/Hidden', access: 'none' }, { path: 'Journal/Hidden/Reopen', access: 'read' },
    ] });
    expect(pathAccess(policy, 'private\u0301/secret.md')).toBe('none');
    expect(pathAccess(policy, 'Journal./note.md')).toBe('read');
    expect(pathAccess(policy, 'Journal /note.md')).toBe('read');
    expect(pathAccess(policy, 'Journal/Hidden/Reopen/note.md')).toBe('none');
    expect(pathAccess(policy, 'v1./note.md')).toBe('write');
    expect(pathAccess(policy, 'Draft /note.md')).toBe('write');
    expect(policyPathKey('Draft /note.md')).toBe('draft/note.md');
  });

  it('rejects traversal and empty normalized segments instead of resolving them', () => {
    for (const path of ['../Private', 'a/../Private', 'a//b', 'a/./b', 'a/   /b', 'a/.../b', 'a\\b', 'a\0b', '/', './', 'a/'.repeat(1024), 'a'.repeat(1024), 'İ'.repeat(600), '_LOCAL/a']) {
      expect(() => pathPolicyForEnv({ MCP_PATH_RULES: [{ path, access: 'none' }] })).toThrow();
    }
    for (const path of ['/a.md', './a.md', '../a.md', 'a/.. /x.md']) expect(policyPathKey(path)).toBeUndefined();
  });

  it('hides dot-folders at any depth but not dot-files, and cannot reopen them', () => {
    const policy = pathPolicyForEnv({ MCP_PATH_RULES: [{ path: '.obsidian/', access: 'read' }], MCP_HIDE_DOT_FOLDERS: 'true' });
    for (const path of ['.obsidian/config.json', 'a/.private/secret.md']) expect(pathAccess(policy, path)).toBe('none');
    expect(pathAccess(policy, '.note.md')).toBe('write');
    expect(pathAccess(pathPolicyForEnv({ MCP_PATH_RULES: [] }), '.obsidian/config.json')).toBe('write');
  });

  it('snapshots trusted policy and wraps every data method without a compatibility probe', async () => {
    const policy = vaultPathPolicySchema.parse({ rules, hideDotFolders: false });
    const calls: Array<{ method: PropertyKey; envelope: unknown }> = [];
    const raw = new Proxy({} as StorageVaultRpc, { get: (_, method) => async (envelope: unknown) => {
      calls.push({ method, envelope });
      return { ok: false, error: { code: 'not_found', message: 'File not found.' } };
    } });
    const wrapped = withVaultPathPolicy(raw, policy);
    const expected = structuredClone(policy);
    policy.rules.length = 0;
    for (const method of Object.keys(wrapped) as Array<keyof typeof wrapped>) {
      if (method === 'vaultStatus') continue;
      // The storage request schemas validate arguments; here exercise the complete wrapper surface.
      await (wrapped[method] as (request: object) => Promise<unknown>)({ path: 'example.md' });
    }
    expect(calls).toHaveLength(13);
    for (const call of calls) expect(call.envelope).toEqual({ request: { path: 'example.md' }, pathPolicy: expected });
    expect(calls.some(({ method }) => method === 'vaultStatus')).toBe(false);
  });
});
