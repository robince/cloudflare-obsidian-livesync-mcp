import type {
  ListVaultFilesData,
  ListVaultFilesRequest,
  ReadVaultFileData,
  ReadVaultFileRequest,
  VaultResult,
  VaultStatusData,
} from '@cloudflare-obsidian-livesync/contracts';

/** The deliberately small read-only surface shared with the storage Worker. */
export interface VaultRpc {
  vaultStatus(): Promise<VaultResult<VaultStatusData>>;
  listVaultFiles(request: ListVaultFilesRequest): Promise<VaultResult<ListVaultFilesData>>;
  readVaultFile(request: ReadVaultFileRequest): Promise<VaultResult<ReadVaultFileData>>;
}

/**
 * Gets the fixed vault Durable Object. The database name comes exclusively
 * from the Worker environment; MCP callers never influence this selection.
 */
export function vaultRpcForEnv(env: Env): VaultRpc {
  const id = env.POUCH_DATABASES.idFromName(env.VAULT_DATABASE);
  return env.POUCH_DATABASES.get(id) as unknown as VaultRpc;
}
