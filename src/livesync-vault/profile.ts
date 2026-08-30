import type { JsonObject } from '../types';

export const MILESTONE_DOCUMENT_ID = '_local/obsydian_livesync_milestone';
export const SYNC_PARAMETERS_DOCUMENT_ID = '_local/obsidian_livesync_sync_parameters';

export type VaultProfileInspection =
  | {
      supported: true;
      fingerprint: string;
      enableCompression: boolean;
      handleFilenameCaseSensitive: boolean;
    }
  | { supported: false; fingerprint: string; reasons: string[] };

export function inspectVaultProfile(
  milestone: JsonObject | undefined,
  syncParameters: JsonObject | undefined
): VaultProfileInspection {
  const fingerprint = `${revisionOf(milestone)}:${revisionOf(syncParameters)}`;
  const reasons: string[] = [];
  const preferred = preferredTweaks(milestone);
  if (!milestone) reasons.push('milestone_missing');
  if (!preferred) reasons.push('preferred_tweak_values_missing');

  if (preferred) {
    if (preferred.encrypt !== false) reasons.push('encryption_unsupported');
    if (preferred.usePathObfuscation !== false) reasons.push('path_obfuscation_unsupported');
  }
  if (reasons.length > 0) return { supported: false, fingerprint, reasons: [...new Set(reasons)] };
  return {
    supported: true,
    fingerprint,
    enableCompression: preferred!.enableCompression === true,
    handleFilenameCaseSensitive: preferred!.handleFilenameCaseSensitive === true,
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

function revisionOf(document: JsonObject | undefined): string {
  return typeof document?._rev === 'string' ? document._rev : 'missing';
}
