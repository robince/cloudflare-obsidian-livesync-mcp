import { McpServer } from '@modelcontextprotocol/server';
import { getMcpAuthContext } from 'agents/mcp/server';
import { z } from 'zod';

import {
  CONTRACT_VERSION,
  VAULT_LIMITS,
  type VaultResult,
} from '@cloudflare-obsidian-livesync/contracts';

import { allowedGithubLogins, normalizeGithubLogin } from './auth-utils';
import type { VaultRpc } from './vault-rpc';

export const READ_SCOPE = 'vault:read';
export const WRITE_SCOPE = 'vault:write';

export function accessTokenScopes(props: { scopes?: unknown } | undefined, requestedScope: unknown): string[] {
  const granted = Array.isArray(props?.scopes) ? props.scopes.filter((scope) => scope === READ_SCOPE || scope === WRITE_SCOPE) : [];
  const uniqueGranted = [...new Set(granted)];
  const requested = Array.isArray(requestedScope)
    ? requestedScope.filter((scope): scope is string => typeof scope === 'string')
    : typeof requestedScope === 'string'
      ? requestedScope.split(/[\s+]+/).filter(Boolean)
      : [];
  if (requestedScope === undefined) return uniqueGranted;
  return uniqueGranted.filter((scope) => requested.includes(scope));
}

export const VAULT_TOOL_NAMES = [
  'vault_status',
  'list_files',
  'read_file',
  'create_file',
  'edit_file',
  'delete_file',
] as const;

export const listFilesInput = z.object({
  prefix: z.string().max(VAULT_LIMITS.maxPathLength).optional(),
  limit: z.number().int().positive().max(VAULT_LIMITS.maxListLimit).optional(),
  cursor: z.string().max(VAULT_LIMITS.maxCursorLength).optional(),
}).strict();

export const readFileInput = z.object({
  path: z.string().min(1).max(VAULT_LIMITS.maxPathLength),
}).strict();

export const createFileInput = z.object({
  path: z.string().min(1).max(VAULT_LIMITS.maxPathLength),
  content: z.string().max(VAULT_LIMITS.maxWriteBytes),
}).strict();

export const editFileInput = z.object({
  path: z.string().min(1).max(VAULT_LIMITS.maxPathLength),
  content: z.string().max(VAULT_LIMITS.maxWriteBytes),
  expectedRevision: z.string().min(1).max(VAULT_LIMITS.maxRevisionLength),
}).strict();

export const deleteFileInput = z.object({
  path: z.string().min(1).max(VAULT_LIMITS.maxPathLength),
  expectedRevision: z.string().min(1).max(VAULT_LIMITS.maxRevisionLength),
}).strict();

export type VaultToolAuth = {
  canRead?: () => boolean;
  canWrite?: () => boolean;
  allowedLogins?: Set<string>;
  writesEnabled?: boolean;
};

/** Creates a fresh stateless MCP server for one request. */
export function createVaultMcpServer(rpc: VaultRpc, auth: VaultToolAuth = {}): McpServer {
  const server = new McpServer({
    name: 'obsidian-livesync',
    version: '0.1.0',
  });
  const handlers = createVaultToolHandlers(rpc, auth);
  const writeResult = z.object({ path: z.string(), revision: z.string() });

  server.registerTool(
    'vault_status',
    {
      description: 'Check whether the configured Obsidian LiveSync vault can be read.',
      outputSchema: z.object({
        contractVersion: z.literal(CONTRACT_VERSION),
        compatible: z.boolean(),
        reasons: z.array(z.string()),
      }),
    },
    handlers.vaultStatus,
  );
  server.registerTool(
    'list_files',
    {
      description: 'List Markdown files in the configured vault.',
      inputSchema: listFilesInput,
      outputSchema: z.object({
        files: z.array(z.object({ path: z.string(), revision: z.string() })),
        cursor: z.string().optional(),
      }),
    },
    handlers.listFiles,
  );
  server.registerTool(
    'read_file',
    {
      description: 'Read one Markdown file from the configured vault.',
      inputSchema: readFileInput,
      outputSchema: z.object({ path: z.string(), revision: z.string(), content: z.string() }),
    },
    handlers.readFile,
  );
  if (auth.writesEnabled === true) {
    server.registerTool(
      'create_file',
      {
        description: 'Create a new Markdown file in the configured vault.',
        inputSchema: createFileInput,
        outputSchema: writeResult,
      },
      handlers.createFile,
    );
    server.registerTool(
      'edit_file',
      {
        description: 'Replace the contents of an existing Markdown file. Requires the current revision.',
        inputSchema: editFileInput,
        outputSchema: writeResult,
      },
      handlers.editFile,
    );
    server.registerTool(
      'delete_file',
      {
        description: 'Delete a Markdown file. Requires the current revision.',
        inputSchema: deleteFileInput,
        outputSchema: writeResult,
      },
      handlers.deleteFile,
    );
  }
  return server;
}

export function createVaultToolHandlers(rpc: VaultRpc, auth: VaultToolAuth = {}) {
  const allowedLogins = auth.allowedLogins ?? new Set<string>();
  const resolved = {
    writesEnabled: auth.writesEnabled === true,
    canRead: auth.canRead ?? (() => hasVaultAccess(getMcpAuthContext()?.props, allowedLogins, READ_SCOPE)),
    canWrite: auth.canWrite ?? (() => {
      const props = getMcpAuthContext()?.props;
      return hasVaultAccess(props, allowedLogins, READ_SCOPE)
        && hasVaultAccess(props, allowedLogins, WRITE_SCOPE);
    }),
  };
  const denied = (scope: string) => ({
    isError: true as const,
    content: [{ type: 'text' as const, text: `Authorization requires an allowlisted GitHub account with the ${scope} scope.` }],
  });
  return {
    vaultStatus: async () => {
      if (!resolved.canRead()) return denied(READ_SCOPE);
      const result = await rpc.vaultStatus();
      if (!result.ok) return vaultFailure(result);
      return success(
        result.data,
        result.data.compatible ? 'Vault is ready.' : 'Vault configuration is unsupported.',
      );
    },
    listFiles: async (request: z.infer<typeof listFilesInput>) => {
      if (!resolved.canRead()) return denied(READ_SCOPE);
      const result = await rpc.listVaultFiles(request);
      if (!result.ok) return vaultFailure(result);
      return success(result.data, `${result.data.files.length} file(s) returned.`);
    },
    readFile: async (request: z.infer<typeof readFileInput>) => {
      if (!resolved.canRead()) return denied(READ_SCOPE);
      const result = await rpc.readVaultFile(request);
      if (!result.ok) return vaultFailure(result);
      return success(result.data, `Read ${result.data.path}.`);
    },
    createFile: async (request: z.infer<typeof createFileInput>) => {
      if (!resolved.writesEnabled || !resolved.canRead() || !resolved.canWrite()) return denied(WRITE_SCOPE);
      const result = await rpc.createVaultFile(request);
      if (!result.ok) return vaultFailure(result);
      return success(result.data, `Created ${result.data.path}.`);
    },
    editFile: async (request: z.infer<typeof editFileInput>) => {
      if (!resolved.writesEnabled || !resolved.canRead() || !resolved.canWrite()) return denied(WRITE_SCOPE);
      const result = await rpc.updateVaultFile(request);
      if (!result.ok) return vaultFailure(result);
      return success(result.data, `Updated ${result.data.path}.`);
    },
    deleteFile: async (request: z.infer<typeof deleteFileInput>) => {
      if (!resolved.writesEnabled || !resolved.canRead() || !resolved.canWrite()) return denied(WRITE_SCOPE);
      const result = await rpc.deleteVaultFile(request);
      if (!result.ok) return vaultFailure(result);
      return success(result.data, `Deleted ${result.data.path}.`);
    },
  };
}

export function hasReadScope(props: Record<string, unknown> | undefined): boolean {
  return hasScope(props, READ_SCOPE);
}

export function hasScope(props: Record<string, unknown> | undefined, scope: string): boolean {
  const scopes = props?.scopes;
  return Array.isArray(scopes) && scopes.includes(scope);
}

export function hasVaultAccess(
  props: Record<string, unknown> | undefined,
  allowedLogins: Set<string>,
  scope: string = READ_SCOPE,
): boolean {
  if (!hasScope(props, scope)) return false;
  const login = typeof props?.githubLogin === 'string' ? normalizeGithubLogin(props.githubLogin) : '';
  return login !== '' && allowedLogins.has(login);
}

export function allowlistFromEnv(env: { GITHUB_ALLOWED_LOGINS?: string }): Set<string> {
  return allowedGithubLogins(env.GITHUB_ALLOWED_LOGINS);
}

function success<T extends object>(data: T, text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: data,
  };
}

function vaultFailure(result: Exclude<VaultResult<unknown>, { ok: true }>) {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: result.error.message }],
  };
}
