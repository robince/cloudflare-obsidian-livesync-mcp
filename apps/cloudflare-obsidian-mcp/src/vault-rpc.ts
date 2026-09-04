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
  UpdateVaultFileRequest,
  VaultResult,
  VaultStatusData,
  WriteVaultFileData,
} from '@cloudflare-obsidian-livesync/contracts';

/** Matches the storage Worker's CouchDB database-name rule. */
export const VAULT_DATABASE_NAME = /^[a-z][a-z0-9_$()+-]*$/;

type VaultRpcEnv = {
  VAULT_DATABASE?: unknown;
  POUCH_DATABASES: { getByName(name: string): unknown };
};

export function isVaultDatabaseName(value: unknown): value is string {
  return typeof value === 'string' && VAULT_DATABASE_NAME.test(value);
}

/** The semantic vault surface shared with the storage Worker. */
export interface VaultRpc {
  vaultStatus(): Promise<VaultResult<VaultStatusData>>;
  listVaultFiles(request: ListVaultFilesRequest): Promise<VaultResult<ListVaultFilesData>>;
  listVaultAttachments(request: ListVaultAttachmentsRequest): Promise<VaultResult<ListVaultAttachmentsData>>;
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

function unavailableRpc(): VaultRpc {
  const invalid: VaultResult<never> = {
    ok: false,
    error: { code: 'unavailable', message: 'VAULT_DATABASE is not a valid CouchDB name.' },
  };
  return {
    vaultStatus: async () => invalid,
    listVaultFiles: async () => invalid,
    listVaultAttachments: async () => invalid,
    readVaultFile: async () => invalid,
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
  return env.POUCH_DATABASES.getByName(env.VAULT_DATABASE) as unknown as VaultRpc;
}
