import type { VaultError } from '@cloudflare-obsidian-livesync/contracts';

export function revisionConflict(path: string): VaultError {
  return {
    code: 'revision_conflict', path, resolution: 'reread_and_reassess',
    message: `The file ${path} changed or already exists. Reread it, reassess your intended change against the current content, and retry only if still appropriate. Do not blindly replay the operation.`,
  };
}

export function livesyncConflict(path: string, unresolvedVersions: number): VaultError {
  return {
    code: 'livesync_conflict', path, unresolvedVersions, resolution: 'obsidian',
    message: `The file ${path} has ${unresolvedVersions} unresolved LiveSync versions. Tell the user to open this vault in a full Obsidian client and resolve the conflict through Self-hosted LiveSync, then sync the resolution. The requested operation was not applied. Do not retry until resolution has synced.`,
  };
}

export function reconciledConflict(path: string, unresolvedVersions: number): VaultError {
  return {
    code: 'conflict_reconciled', path, unresolvedVersions, resolution: 'reread_and_reassess',
    message: `Safe LiveSync conflict reconciliation changed ${path}. The requested operation was not applied. Reread the file and reassess your change before retrying; remaining conflicts may require Obsidian resolution.`,
  };
}

export function throwVaultError(error: VaultError): never {
  throw Object.assign(new Error(error.message), error);
}
