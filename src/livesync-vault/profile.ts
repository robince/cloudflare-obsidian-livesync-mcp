import type { JsonObject } from '../types';

export const MILESTONE_DOCUMENT_ID = '_local/obsydian_livesync_milestone';

export type VaultProfileInspection =
  | {
      supported: true;
      enableCompression: boolean;
      handleFilenameCaseSensitive: boolean;
      hashAlg: 'xxhash64';
    }
  | { supported: false; reasons: string[] };

export function inspectVaultProfile(
  milestone: JsonObject | undefined
): VaultProfileInspection {
  const reasons: string[] = [];
  const preferred = preferredTweaks(milestone);
  if (!milestone) reasons.push('milestone_missing');
  if (!preferred) reasons.push('preferred_tweak_values_missing');

  if (preferred) {
    if (preferred.encrypt !== false) reasons.push('encryption_unsupported');
    if (preferred.usePathObfuscation !== false) reasons.push('path_obfuscation_unsupported');
    if (preferred.hashAlg !== 'xxhash64') reasons.push('hash_algorithm_unsupported');
  }
  if (reasons.length > 0) return { supported: false, reasons: [...new Set(reasons)] };
  return {
    supported: true,
    enableCompression: preferred!.enableCompression === true,
    handleFilenameCaseSensitive: preferred!.handleFilenameCaseSensitive === true,
    hashAlg: 'xxhash64',
  };
}

function preferredTweaks(milestone: JsonObject | undefined): JsonObject | undefined {
  const tweakValues = milestone?.tweak_values;
  if (!tweakValues || typeof tweakValues !== 'object' || Array.isArray(tweakValues)) return undefined;
  const preferred = (tweakValues as JsonObject).PREFERRED;
  return preferred && typeof preferred === 'object' && !Array.isArray(preferred)
    ? preferred as JsonObject
    : undefined;
}

