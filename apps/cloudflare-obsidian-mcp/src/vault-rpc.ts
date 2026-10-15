import type { VaultPathPolicy, VaultRpcRequest } from '@cloudflare-obsidian-livesync/contracts';
import { pathPolicyForEnv } from './path-policy';
import type { GetVaultFileOutlineRequest, GetVaultFileOutlineData } from '@cloudflare-obsidian-livesync/contracts';
import type {
  AppendVaultFileRequest,
  CreateVaultFileRequest,
  DeleteVaultFileRequest,
  ListVaultAttachmentsData,
  ListVaultAttachmentsRequest,
  ListVaultFilesData,
  ListVaultFilesRequest,
  PatchVaultFileData,
  PatchVaultFileRequest,
  PatchVaultFrontmatterData,
  PatchVaultFrontmatterRequest,
  ReadVaultAttachmentData,
  ReadVaultAttachmentRequest,
  ReadVaultFileData,
  ReadVaultFileRequest,
  ReadVaultFrontmatterData,
  ReadVaultFrontmatterRequest,
  SearchVaultFilesData,
  SearchVaultFilesRequest,
  UpdateVaultFileRequest,
  VaultResult,
  VaultStatusData,
  WriteVaultFileData,
} from '@cloudflare-obsidian-livesync/contracts';

/** Matches the storage Worker's CouchDB database-name rule. */
export const VAULT_DATABASE_NAME = /^[a-z][a-z0-9_$()+-]*$/;

type VaultRpcEnv = {
  VAULT_DATABASE?: unknown;
  MCP_PATH_RULES?: unknown;
  MCP_HIDE_DOT_FOLDERS?: unknown;
  POUCH_DATABASES: { getByName(name: string): unknown };
};

export function isVaultDatabaseName(value: unknown): value is string {
  return typeof value === 'string' && VAULT_DATABASE_NAME.test(value);
}

/** The semantic vault surface shared with the storage Worker. */
export interface VaultRpc {
  vaultStatus(): Promise<VaultResult<VaultStatusData>>;
  listVaultFiles(request: ListVaultFilesRequest): Promise<VaultResult<ListVaultFilesData>>;
  searchVaultFiles(request: SearchVaultFilesRequest): Promise<VaultResult<SearchVaultFilesData>>;
  listVaultAttachments(request: ListVaultAttachmentsRequest): Promise<VaultResult<ListVaultAttachmentsData>>;
  getVaultFileOutline(request: GetVaultFileOutlineRequest): Promise<VaultResult<GetVaultFileOutlineData>>;
  readVaultFile(request: ReadVaultFileRequest): Promise<VaultResult<ReadVaultFileData>>;
  readVaultAttachment(request: ReadVaultAttachmentRequest): Promise<VaultResult<ReadVaultAttachmentData>>;
  readVaultFrontmatter(request: ReadVaultFrontmatterRequest): Promise<VaultResult<ReadVaultFrontmatterData>>;
  createVaultFile(request: CreateVaultFileRequest): Promise<VaultResult<WriteVaultFileData>>;
  updateVaultFile(request: UpdateVaultFileRequest): Promise<VaultResult<WriteVaultFileData>>;
  appendVaultFile(request: AppendVaultFileRequest): Promise<VaultResult<WriteVaultFileData>>;
  patchVaultFile(request: PatchVaultFileRequest): Promise<VaultResult<PatchVaultFileData>>;
  patchVaultFrontmatter(request: PatchVaultFrontmatterRequest): Promise<VaultResult<PatchVaultFrontmatterData>>;
  deleteVaultFile(request: DeleteVaultFileRequest): Promise<VaultResult<WriteVaultFileData>>;
}

/** Internal wire surface: policy is never a public tool argument. */
export type StorageVaultRpc = {
  [K in keyof VaultRpc]: K extends 'vaultStatus' ? VaultRpc[K]
    : VaultRpc[K] extends (request: infer R) => infer Result ? (envelope: VaultRpcRequest<R>) => Result : never;
};

export function withVaultPathPolicy(rpc: StorageVaultRpc, policy: VaultPathPolicy): VaultRpc {
  // Configuration is already validated; storage independently validates the wire envelope.
  // Snapshot so callers cannot mutate policy while calls are in flight.
  const pathPolicy = structuredClone(policy);
  return {
    vaultStatus: () => rpc.vaultStatus(),
    listVaultFiles: (request) => rpc.listVaultFiles({ request, pathPolicy }),
    searchVaultFiles: (request) => rpc.searchVaultFiles({ request, pathPolicy }),
    listVaultAttachments: (request) => rpc.listVaultAttachments({ request, pathPolicy }),
    getVaultFileOutline: (request) => rpc.getVaultFileOutline({ request, pathPolicy }),
    readVaultFile: (request) => rpc.readVaultFile({ request, pathPolicy }),
    readVaultAttachment: (request) => rpc.readVaultAttachment({ request, pathPolicy }),
    readVaultFrontmatter: (request) => rpc.readVaultFrontmatter({ request, pathPolicy }),
    createVaultFile: (request) => rpc.createVaultFile({ request, pathPolicy }),
    updateVaultFile: (request) => rpc.updateVaultFile({ request, pathPolicy }),
    appendVaultFile: (request) => rpc.appendVaultFile({ request, pathPolicy }),
    patchVaultFile: (request) => rpc.patchVaultFile({ request, pathPolicy }),
    patchVaultFrontmatter: (request) => rpc.patchVaultFrontmatter({ request, pathPolicy }),
    deleteVaultFile: (request) => rpc.deleteVaultFile({ request, pathPolicy }),
  };
}

function unavailableRpc(): VaultRpc {
  const invalid: VaultResult<never> = {
    ok: false,
    error: { code: 'unavailable', message: 'VAULT_DATABASE is not a valid CouchDB name.' },
  };
  return {
    vaultStatus: async () => invalid,
    listVaultFiles: async () => invalid,
    searchVaultFiles: async () => invalid,
    listVaultAttachments: async () => invalid,
    readVaultFile: async () => invalid,
    getVaultFileOutline: async () => invalid,
    readVaultAttachment: async () => invalid,
    readVaultFrontmatter: async () => invalid,
    createVaultFile: async () => invalid,
    updateVaultFile: async () => invalid,
    appendVaultFile: async () => invalid,
    patchVaultFile: async () => invalid,
    patchVaultFrontmatter: async () => invalid,
    deleteVaultFile: async () => invalid,
  };
}

/**
 * Gets the fixed vault Durable Object. The database name comes exclusively
 * from the Worker environment; MCP callers never influence this selection.
 */
export function vaultRpcForEnv(env: VaultRpcEnv): VaultRpc {
  if (!isVaultDatabaseName(env.VAULT_DATABASE)) return unavailableRpc();
  const pathPolicy = pathPolicyForEnv(env);
  // Wrangler cannot infer methods on a namespace exported by another Worker.
  const storage = env.POUCH_DATABASES.getByName(env.VAULT_DATABASE) as StorageVaultRpc;
  return withVaultPathPolicy(storage, pathPolicy);
}
