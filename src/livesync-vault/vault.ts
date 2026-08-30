import {
  CONTRACT_VERSION,
  listVaultFilesRequestSchema,
  readVaultFileRequestSchema,
  VAULT_LIMITS,
  type ListVaultFilesRequest,
  type ListVaultFilesData,
  type ReadVaultFileRequest,
  type ReadVaultFileData,
  type VaultErrorCode,
  type VaultResult,
  type VaultStatusData,
} from '@cloudflare-obsidian-livesync/contracts';

import type { CommonlibFacade, CommonlibFileMetadata } from './commonlib';
import type { VaultProfileInspection } from './profile';

type VaultDependencies = {
  profile: () => Promise<VaultProfileInspection>;
  commonlib: () => Promise<CommonlibFacade>;
};

type Cursor = { v: 1; prefix: string; id: string };

/** Read-only logical vault operations exposed by the storage Durable Object. */
export class LiveSyncVault {
  constructor(private readonly dependencies: VaultDependencies) {}

  async status(): Promise<VaultResult<VaultStatusData>> {
    try {
      const profile = await this.dependencies.profile();
      return success({
        contractVersion: CONTRACT_VERSION,
        compatible: profile.supported,
        reasons: profile.supported ? [] : profile.reasons,
      });
    } catch (error) {
      return failure(errorCode(error), errorMessage(error));
    }
  }

  async list(request: ListVaultFilesRequest): Promise<VaultResult<ListVaultFilesData>> {
    const parsed = listVaultFilesRequestSchema.safeParse(request);
    if (!parsed.success) return failure('invalid_input', 'Invalid file listing request.');

    const prefix = parsed.data.prefix ?? '';
    if (!isSafePrefix(prefix)) return failure('invalid_input', 'Prefix must be a safe relative path.');

    const cursor = decodeCursor(parsed.data.cursor, prefix);
    if (parsed.data.cursor && !cursor) return failure('invalid_input', 'Cursor does not match this prefix.');
    const limit = parsed.data.limit ?? VAULT_LIMITS.defaultListLimit;

    try {
      const profileError = await this.unsupportedProfile();
      if (profileError) return profileError;
      const allFiles = await (await this.dependencies.commonlib()).list();
      const files = allFiles
        .filter((file) => isMarkdownPath(file.path) && file.path.startsWith(prefix))
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
      const remaining = cursor ? files.filter((file) => file.id > cursor.id) : files;
      const page = remaining.slice(0, limit);
      const next = remaining.length > page.length && page.length > 0
        ? encodeCursor({ v: 1, prefix, id: page[page.length - 1].id })
        : undefined;
      return success({
        files: page.map(toPublicFile),
        ...(next ? { cursor: next } : {}),
      });
    } catch (error) {
      return failure(errorCode(error), errorMessage(error));
    }
  }

  async read(request: ReadVaultFileRequest): Promise<VaultResult<ReadVaultFileData>> {
    const parsed = readVaultFileRequestSchema.safeParse(request);
    if (!parsed.success || !isMarkdownPath(parsed.data?.path ?? '')) {
      return failure('invalid_input', 'Path must be a safe relative Markdown file.');
    }

    try {
      const profileError = await this.unsupportedProfile();
      if (profileError) return profileError;
      const file = await (await this.dependencies.commonlib()).read(parsed.data.path);
      if (!file) return failure('not_found', 'File not found.');
      if (new TextEncoder().encode(file.content).byteLength > VAULT_LIMITS.maxReadBytes) {
        return failure('too_large', 'File exceeds the read size limit.');
      }
      return success({ path: parsed.data.path, revision: file.revision, content: file.content });
    } catch (error) {
      return failure(errorCode(error), errorMessage(error));
    }
  }

  private async unsupportedProfile(): Promise<VaultResult<never> | undefined> {
    const profile = await this.dependencies.profile();
    if (profile.supported) return undefined;
    return failure('unsupported', `Unsupported LiveSync vault (${profile.reasons.join(', ')}).`);
  }
}

function success<T>(data: T): VaultResult<T> {
  return { ok: true, data };
}

function failure(code: VaultErrorCode, message: string): VaultResult<never> {
  return { ok: false, error: { code, message } };
}

function toPublicFile(file: CommonlibFileMetadata) {
  return { path: file.path, revision: file.revision };
}

function isSafePrefix(prefix: string): boolean {
  if (prefix === '') return true;
  if (prefix.startsWith('/') || prefix.includes('\\') || prefix.includes('\0') || prefix.startsWith('h:')) return false;
  const segments = (prefix.endsWith('/') ? prefix.slice(0, -1) : prefix).split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function isMarkdownPath(path: string): boolean {
  return path.endsWith('.md') && isSafePrefix(path);
}

function encodeCursor(cursor: Cursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeCursor(value: string | undefined, prefix: string): Cursor | undefined {
  if (!value) return undefined;
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/') + '==='.slice((value.length + 3) % 4);
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Cursor;
    return parsed.v === 1 && parsed.prefix === prefix && typeof parsed.id === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function errorCode(error: unknown): VaultErrorCode {
  if (error && typeof error === 'object' && 'status' in error) {
    if (error.status === 404) return 'not_found';
    if (error.status === 503) return 'unavailable';
  }
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('unsupported LiveSync profile')) return 'unsupported';
  return 'internal';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Vault operation failed.';
}
