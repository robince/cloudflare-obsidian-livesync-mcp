import type { VaultPathPolicy, VaultRpcRequest } from '@cloudflare-obsidian-livesync/contracts';

export const unrestrictedPolicy: VaultPathPolicy = { rules: [], hideDotFolders: false };

/** Existing protocol tests explicitly opt into unrestricted semantic access. */
export function rpcRequest<T>(request: T): VaultRpcRequest<T> {
  return { request, pathPolicy: unrestrictedPolicy };
}
