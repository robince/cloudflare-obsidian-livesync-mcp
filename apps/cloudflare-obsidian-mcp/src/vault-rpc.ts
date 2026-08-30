import type {
  CreateVaultFileRequest,
  DeleteVaultFileRequest,
  ListVaultFilesData,
  ListVaultFilesRequest,
  MoveVaultFileData,
  MoveVaultFileRequest,
  ReadVaultFileData,
  ReadVaultFileRequest,
  UpdateVaultFileRequest,
  VaultResult,
  VaultStatusData,
  WriteVaultFileData,
} from '@cloudflare-obsidian-livesync/contracts';

/** Matches the storage Worker's CouchDB database-name rule. */
export const VAULT_DATABASE_NAME = /^[a-z][a-z0-9_$()+-]*$/;

/** The semantic vault surface shared with the storage Worker. */
export interface VaultRpc {
  vaultStatus(): Promise<VaultResult<VaultStatusData>>;
  listVaultFiles(request: ListVaultFilesRequest): Promise<VaultResult<ListVaultFilesData>>;
  readVaultFile(request: ReadVaultFileRequest): Promise<VaultResult<ReadVaultFileData>>;
  createVaultFile(request: CreateVaultFileRequest): Promise<VaultResult<WriteVaultFileData>>;
  updateVaultFile(request: UpdateVaultFileRequest): Promise<VaultResult<WriteVaultFileData>>;
  deleteVaultFile(request: DeleteVaultFileRequest): Promise<VaultResult<WriteVaultFileData>>;
  moveVaultFile(request: MoveVaultFileRequest): Promise<VaultResult<MoveVaultFileData>>;
}

function unavailableRpc(): VaultRpc {
  const invalid: VaultResult<never> = {
    ok: false,
    error: { code: 'internal', message: 'VAULT_DATABASE is not a valid CouchDB name.' },
  };
  return {
    vaultStatus: async () => invalid,
    listVaultFiles: async () => invalid,
    readVaultFile: async () => invalid,
    createVaultFile: async () => invalid,
    updateVaultFile: async () => invalid,
    deleteVaultFile: async () => invalid,
    moveVaultFile: async () => invalid,
  };
}

/**
 * Gets the fixed vault Durable Object. The database name comes exclusively
 * from the Worker environment; MCP callers never influence this selection.
 */
export function vaultRpcForEnv(env: Env): VaultRpc {
  if (!VAULT_DATABASE_NAME.test(env.VAULT_DATABASE)) return unavailableRpc();
  return env.POUCH_DATABASES.getByName(env.VAULT_DATABASE) as unknown as VaultRpc;
}
