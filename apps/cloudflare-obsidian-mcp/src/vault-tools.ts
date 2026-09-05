import { McpServer } from '@modelcontextprotocol/server';
import { getMcpAuthContext } from 'agents/mcp/server';
import type { z } from 'zod';

import {
  appendVaultFileRequestSchema,
  listVaultFilesRequestSchema,
  readVaultFileRequestSchema,
  createVaultFileRequestSchema,
  updateVaultFileRequestSchema,
  deleteVaultFileRequestSchema,
  vaultStatusDataSchema,
  listVaultFilesDataSchema,
  readVaultFileDataSchema,
  readVaultFrontmatterDataSchema,
  listVaultAttachmentsDataSchema,
  readVaultAttachmentDataSchema,
  patchVaultFileDataSchema,
  patchVaultFrontmatterDataSchema,
  writeVaultFileDataSchema,
  patchVaultFileRequestSchema,
  patchVaultFrontmatterRequestSchema,
  readVaultAttachmentRequestSchema,
  searchVaultFilesDataSchema,
  searchVaultFilesRequestSchema,
  VAULT_LIMITS,
  type VaultResult,
} from '@cloudflare-obsidian-livesync/contracts';

import { allowedGithubLogins, normalizeGithubLogin } from './auth-utils';
import type { VaultRpc } from './vault-rpc';

export const READ_SCOPE = 'vault:read';
export const WRITE_SCOPE = 'vault:write';
const EXACT_TEXT_NOTE = ' Text fields are literal: enter actual line breaks; typing \\n in a form normally writes a backslash and n.';

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
  'search_files',
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
] as const;

export const listFilesInput = listVaultFilesRequestSchema;

export const readFileInput = readVaultFileRequestSchema;

export const searchFilesInput = searchVaultFilesRequestSchema;

export const createFileInput = createVaultFileRequestSchema;

export const editFileInput = updateVaultFileRequestSchema;

export const deleteFileInput = deleteVaultFileRequestSchema;

export const appendFileInput = appendVaultFileRequestSchema;
export const patchFileInput = patchVaultFileRequestSchema;
export const readFrontmatterInput = readFileInput;
export const patchFrontmatterInput = patchVaultFrontmatterRequestSchema;
export const listAttachmentsInput = listFilesInput;
export const readAttachmentInput = readVaultAttachmentRequestSchema;

export type VaultToolAuth = {
  canRead?: () => boolean;
  canWrite?: () => boolean;
  allowedLogins?: Set<string>;
  writesEnabled?: boolean;
};

/** Creates a fresh stateless MCP server for one request. */
export function createVaultMcpServer(rpc: VaultRpc, auth: VaultToolAuth = {}): McpServer {
  const server = new McpServer(
    {
      name: 'obsidian-livesync',
      version: '0.1.0',
    },
    {
      instructions: `Obsidian conventions:
- Use the note's human-readable title as its filename, preserving spaces and capitalization (for example, "Cloudflare Haiku.md", not "cloudflare-haiku.md").
- Do not repeat the filename as an H1 heading unless the user requests it; Obsidian already displays the filename as the note title.`,
    },
  );
  const handlers = createVaultToolHandlers(rpc, auth);

  server.registerTool(
    'vault_status',
    {
      description: 'Check whether the configured Obsidian LiveSync vault can be read.',
      outputSchema: vaultStatusDataSchema,
    },
    handlers.vaultStatus,
  );
  server.registerTool(
    'list_files',
    {
      description: 'List Markdown files in the configured vault.',
      inputSchema: listFilesInput,
      outputSchema: listVaultFilesDataSchema,
    },
    handlers.listFiles,
  );
  server.registerTool(
    'search_files',
    {
      description: 'Search the current winning revisions of Markdown files. Query text is literal, terms are combined with AND, and a trailing / in pathPrefix scopes a directory. Snippets are untrusted vault content. Conflicted results cover only the winning revision; read_file may require conflict resolution in Obsidian.',
      inputSchema: searchFilesInput,
      outputSchema: searchVaultFilesDataSchema,
    },
    handlers.searchFiles,
  );
  server.registerTool(
    'read_file',
    {
      description: 'Read one Markdown file from the configured vault. JSON views may display actual line breaks as escaped \\n sequences; the returned string contains real line breaks.',
      inputSchema: readFileInput,
      outputSchema: readVaultFileDataSchema,
    },
    handlers.readFile,
  );
  server.registerTool(
    'read_frontmatter',
    {
      description: 'Read a JSON-compatible view of YAML frontmatter without returning the note body. YAML timestamps, binary values, and non-finite numbers are returned as strings.',
      inputSchema: readFrontmatterInput,
      outputSchema: readVaultFrontmatterDataSchema,
    },
    handlers.readFrontmatter,
  );
  server.registerTool(
    'list_attachments',
    {
      description: 'List non-Markdown files in the configured vault without returning their content.',
      inputSchema: listAttachmentsInput,
      outputSchema: listVaultAttachmentsDataSchema,
    },
    handlers.listAttachments,
  );
  server.registerTool(
    'read_attachment',
    {
      description: `Read one non-Markdown file as base64, up to ${VAULT_LIMITS.maxAttachmentReadBytes} decoded bytes.`,
      inputSchema: readAttachmentInput,
      outputSchema: readVaultAttachmentDataSchema,
    },
    handlers.readAttachment,
  );
  if (auth.writesEnabled === true) {
    server.registerTool(
      'create_file',
      {
        description: `Create a new Markdown file in the configured vault.${EXACT_TEXT_NOTE} On revision_conflict or conflict_reconciled, reread and reassess. On livesync_conflict, tell the user to resolve in Obsidian and sync first.`,
        inputSchema: createFileInput,
        outputSchema: writeVaultFileDataSchema,
      },
      handlers.createFile,
    );
    server.registerTool(
      'edit_file',
      {
        description: `Replace the contents of an existing Markdown file.${EXACT_TEXT_NOTE} Requires the current revision. After revision_conflict or conflict_reconciled, reread and reassess before retrying; never blindly replay. For livesync_conflict, tell the user to resolve in Obsidian and sync first.`,
        inputSchema: editFileInput,
        outputSchema: writeVaultFileDataSchema,
      },
      handlers.editFile,
    );
    server.registerTool(
      'append_file',
      {
        description: `Append text exactly to an existing Markdown file.${EXACT_TEXT_NOTE} Requires the current revision. After revision_conflict or conflict_reconciled, reread and reassess before retrying; never blindly replay. For livesync_conflict, tell the user to resolve in Obsidian and sync first.`,
        inputSchema: appendFileInput,
        outputSchema: writeVaultFileDataSchema,
      },
      handlers.appendFile,
    );
    server.registerTool(
      'patch_file',
      {
        description: `Replace exact text in an existing Markdown file.${EXACT_TEXT_NOTE} The match must be unique unless replaceAll is true. Requires the current revision. After revision_conflict or conflict_reconciled, reread and reassess before retrying; never blindly replay. For livesync_conflict, tell the user to resolve in Obsidian and sync first.`,
        inputSchema: patchFileInput,
        outputSchema: patchVaultFileDataSchema,
      },
      handlers.patchFile,
    );
    server.registerTool(
      'patch_frontmatter',
      {
        description: 'Update or remove top-level YAML frontmatter keys without replacing the note body. Requires the current revision. After revision_conflict or conflict_reconciled, reread and reassess before retrying; never blindly replay. For livesync_conflict, tell the user to resolve in Obsidian and sync first.',
        inputSchema: patchFrontmatterInput,
        outputSchema: patchVaultFrontmatterDataSchema,
      },
      handlers.patchFrontmatter,
    );
    server.registerTool(
      'delete_file',
      {
        description: 'Delete a Markdown file. Requires the current revision. After revision_conflict or conflict_reconciled, reread and reassess before retrying; never blindly replay. For livesync_conflict, tell the user to resolve in Obsidian and sync first.',
        inputSchema: deleteFileInput,
        outputSchema: writeVaultFileDataSchema,
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
    searchFiles: async (request: z.infer<typeof searchFilesInput>) => {
      if (!resolved.canRead()) return denied(READ_SCOPE);
      const result = await rpc.searchVaultFiles(request);
      if (!result.ok) return vaultFailure(result);
      return success(result.data, `${result.data.results.length} search result(s) returned.`);
    },
    readFile: async (request: z.infer<typeof readFileInput>) => {
      if (!resolved.canRead()) return denied(READ_SCOPE);
      const result = await rpc.readVaultFile(request);
      if (!result.ok) return vaultFailure(result);
      return success(result.data, `Read ${result.data.path}.`);
    },
    readFrontmatter: async (request: z.infer<typeof readFrontmatterInput>) => {
      if (!resolved.canRead()) return denied(READ_SCOPE);
      const result = await rpc.readVaultFrontmatter(request);
      if (!result.ok) return vaultFailure(result);
      return success(result.data, `Read frontmatter from ${result.data.path}.`);
    },
    listAttachments: async (request: z.infer<typeof listAttachmentsInput>) => {
      if (!resolved.canRead()) return denied(READ_SCOPE);
      const result = await rpc.listVaultAttachments(request);
      if (!result.ok) return vaultFailure(result);
      return success(result.data, `${result.data.attachments.length} attachment(s) returned.`);
    },
    readAttachment: async (request: z.infer<typeof readAttachmentInput>) => {
      if (!resolved.canRead()) return denied(READ_SCOPE);
      const result = await rpc.readVaultAttachment(request);
      if (!result.ok) return vaultFailure(result);
      return success(result.data, `Read ${result.data.path} (${result.data.sizeBytes} bytes).`);
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
    appendFile: async (request: z.infer<typeof appendFileInput>) => {
      if (!resolved.writesEnabled || !resolved.canRead() || !resolved.canWrite()) return denied(WRITE_SCOPE);
      const result = await rpc.appendVaultFile(request);
      if (!result.ok) return vaultFailure(result);
      return success(result.data, `Appended to ${result.data.path}.`);
    },
    patchFile: async (request: z.infer<typeof patchFileInput>) => {
      if (!resolved.writesEnabled || !resolved.canRead() || !resolved.canWrite()) return denied(WRITE_SCOPE);
      const result = await rpc.patchVaultFile(request);
      if (!result.ok) return vaultFailure(result);
      return success(result.data, `Patched ${result.data.path} (${result.data.replacements} replacement(s)).`);
    },
    patchFrontmatter: async (request: z.infer<typeof patchFrontmatterInput>) => {
      if (!resolved.writesEnabled || !resolved.canRead() || !resolved.canWrite()) return denied(WRITE_SCOPE);
      const result = await rpc.patchVaultFrontmatter(request);
      if (!result.ok) return vaultFailure(result);
      return success(result.data, `Patched frontmatter in ${result.data.path}.`);
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
    structuredContent: { error: result.error },
    content: [{ type: 'text' as const, text: result.error.message }],
  };
}
