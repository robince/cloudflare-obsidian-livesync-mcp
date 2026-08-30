import { McpServer } from '@modelcontextprotocol/server';
import { getMcpAuthContext } from 'agents/mcp/server';
import { z } from 'zod';

import type { VaultResult } from '@cloudflare-obsidian-livesync/contracts';
import type { VaultRpc } from './vault-rpc';

const MAX_PATH_LENGTH = 1024;
const MAX_CURSOR_LENGTH = 2048;

export const VAULT_TOOL_NAMES = ['vault_status', 'list_files', 'read_file'] as const;

export const listFilesInput = z.object({
  prefix: z.string().max(MAX_PATH_LENGTH).optional(),
  limit: z.number().int().positive().max(100).optional(),
  cursor: z.string().max(MAX_CURSOR_LENGTH).optional(),
}).strict();

export const readFileInput = z.object({
  path: z.string().min(1).max(MAX_PATH_LENGTH),
}).strict();

/** Creates a fresh stateless MCP server for one request. */
export function createVaultMcpServer(rpc: VaultRpc): McpServer {
  const server = new McpServer({
    name: 'obsidian-livesync',
    version: '0.1.0',
  });
  const handlers = createVaultToolHandlers(rpc);

  server.registerTool(
    'vault_status',
    {
      description: 'Check whether the configured Obsidian LiveSync vault can be read.',
      outputSchema: z.object({
        contractVersion: z.literal(1),
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

  return server;
}

export function createVaultToolHandlers(
  rpc: VaultRpc,
  canRead: () => boolean = () => hasReadScope(getMcpAuthContext()?.props),
) {
  const denied = () => ({
    isError: true as const,
    content: [{ type: 'text' as const, text: 'Authorization requires the vault:read scope.' }],
  });
  return {
    vaultStatus: async () => {
      if (!canRead()) return denied();
      const result = await rpc.vaultStatus();
      if (!result.ok) return vaultFailure(result);
      return success(
        result.data,
        result.data.compatible ? 'Vault is ready for read-only access.' : 'Vault configuration is unsupported.',
      );
    },
    listFiles: async (request: z.infer<typeof listFilesInput>) => {
      if (!canRead()) return denied();
      const result = await rpc.listVaultFiles(request);
      if (!result.ok) return vaultFailure(result);
      return success(result.data, `${result.data.files.length} file(s) returned.`);
    },
    readFile: async (request: z.infer<typeof readFileInput>) => {
      if (!canRead()) return denied();
      const result = await rpc.readVaultFile(request);
      if (!result.ok) return vaultFailure(result);
      return success(result.data, `Read ${result.data.path}.`);
    },
  };
}

export function hasReadScope(props: Record<string, unknown> | undefined): boolean {
  const scopes = props?.scopes;
  return Array.isArray(scopes) && scopes.includes('vault:read');
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
    structuredContent: { error: result.error },
  };
}
