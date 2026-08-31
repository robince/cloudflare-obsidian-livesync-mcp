import {
  CONTRACT_VERSION,
  createVaultFileRequestSchema,
  deleteVaultFileRequestSchema,
  listVaultFilesRequestSchema,
  readVaultFileRequestSchema,
  updateVaultFileRequestSchema,
  VAULT_LIMITS,
  type CreateVaultFileRequest,
  type DeleteVaultFileRequest,
  type ListVaultFilesRequest,
  type ListVaultFilesData,
  type ReadVaultFileRequest,
  type ReadVaultFileData,
  type UpdateVaultFileRequest,
  type VaultErrorCode,
  type VaultResult,
  type VaultStatusData,
  type WriteVaultFileData,
} from '@cloudflare-obsidian-livesync/contracts';

import type { CommonlibFacade, CommonlibFileMetadata } from './commonlib';
import type { VaultProfileInspection } from './profile';

type VaultDependencies = {
  profile: () => Promise<VaultProfileInspection>;
  acquireCommonlib: () => Promise<CommonlibFacade>;
  releaseCommonlib: () => Promise<void>;
};

type Cursor = { v: 1; prefix: string; id: string };

/** Logical vault operations exposed by the storage Durable Object. */
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

    return this.withCommonlib(async (commonlib, profile) => {
      const page: CommonlibFileMetadata[] = [];
      let extra = false;
      for await (const file of commonlib.enumerate()) {
        if (!isListedMarkdown(file, prefix, profile.handleFilenameCaseSensitive)) continue;
        if (cursor && file.id <= cursor.id) continue;
        if (page.length === limit) {
          extra = true;
          break;
        }
        page.push(file);
      }
      const next = extra && page.length > 0
        ? encodeCursor({ v: 1, prefix, id: page[page.length - 1].id })
        : undefined;
      return success({
        files: page.map(toPublicFile),
        ...(next ? { cursor: next } : {}),
      });
    });
  }

  async read(request: ReadVaultFileRequest): Promise<VaultResult<ReadVaultFileData>> {
    const parsed = readVaultFileRequestSchema.safeParse(request);
    if (!parsed.success || !isMarkdownPath(parsed.data?.path ?? '')) {
      return failure('invalid_input', 'Path must be a safe relative Markdown file.');
    }

    return this.withCommonlib(async (commonlib) => {
      const meta = await commonlib.inspect(parsed.data.path);
      if (!meta) return failure('not_found', 'File not found.');
      if (meta.datatype !== 'plain') {
        return failure('unsupported', 'Only plain Markdown notes can be read.');
      }
      if (typeof meta.size === 'number' && meta.size > VAULT_LIMITS.maxReadBytes) {
        return failure('too_large', 'File exceeds the read size limit.');
      }
      const file = await commonlib.read(parsed.data.path);
      if (!file) return failure('not_found', 'File not found.');
      if (new TextEncoder().encode(file.content).byteLength > VAULT_LIMITS.maxReadBytes) {
        return failure('too_large', 'File exceeds the read size limit.');
      }
      return success({ path: parsed.data.path, revision: file.revision, content: file.content });
    });
  }

  async create(request: CreateVaultFileRequest): Promise<VaultResult<WriteVaultFileData>> {
    const parsed = createVaultFileRequestSchema.safeParse(request);
    if (!parsed.success || !isMarkdownPath(parsed.data?.path ?? '')) {
      return failure('invalid_input', 'Path must be a safe relative Markdown file.');
    }
    const contentError = contentTooLarge(parsed.data.content);
    if (contentError) return contentError;

    return this.withCommonlib(async (commonlib) => {
      const existing = await commonlib.inspect(parsed.data.path);
      if (existing) return failure('conflict', 'File already exists.');
      const now = Date.now();
      const written = await commonlib.write(parsed.data.path, parsed.data.content, {
        ctime: now,
        mtime: now,
        size: utf8Bytes(parsed.data.content),
      });
      if (!written) return failure('conflict', 'File already exists.');
      return success({ path: parsed.data.path, revision: written.revision });
    });
  }

  async update(request: UpdateVaultFileRequest): Promise<VaultResult<WriteVaultFileData>> {
    const parsed = updateVaultFileRequestSchema.safeParse(request);
    if (!parsed.success || !isMarkdownPath(parsed.data?.path ?? '')) {
      return failure('invalid_input', 'Path must be a safe relative Markdown file.');
    }
    const contentError = contentTooLarge(parsed.data.content);
    if (contentError) return contentError;

    return this.withCommonlib(async (commonlib) => {
      const existing = await commonlib.inspect(parsed.data.path);
      if (!existing) return failure('not_found', 'File not found.');
      if (existing.datatype !== 'plain') {
        return failure('unsupported', 'Only plain Markdown notes can be updated.');
      }
      const written = await commonlib.write(
        parsed.data.path,
        parsed.data.content,
        {
          ctime: existing.ctime ?? Date.now(),
          mtime: Date.now(),
          size: utf8Bytes(parsed.data.content),
        },
        parsed.data.expectedRevision
      );
      if (!written) return failure('conflict', 'The file was modified by another client.');
      return success({ path: parsed.data.path, revision: written.revision });
    });
  }

  async delete(request: DeleteVaultFileRequest): Promise<VaultResult<WriteVaultFileData>> {
    const parsed = deleteVaultFileRequestSchema.safeParse(request);
    if (!parsed.success || !isMarkdownPath(parsed.data?.path ?? '')) {
      return failure('invalid_input', 'Path must be a safe relative Markdown file.');
    }

    return this.withCommonlib(async (commonlib) => {
      const existing = await commonlib.inspect(parsed.data.path);
      if (!existing) return failure('not_found', 'File not found.');
      if (existing.revision !== parsed.data.expectedRevision) {
        return failure('conflict', 'The file was modified by another client.');
      }
      const removed = await commonlib.remove(parsed.data.path, parsed.data.expectedRevision);
      if (!removed) return failure('conflict', 'The file was modified by another client.');
      return success({ path: parsed.data.path, revision: removed.revision });
    });
  }

  private async withCommonlib<T>(
    operation: (commonlib: CommonlibFacade, profile: Extract<VaultProfileInspection, { supported: true }>) => Promise<VaultResult<T>>
  ): Promise<VaultResult<T>> {
    try {
      const profile = await this.dependencies.profile();
      if (!profile.supported) {
        return failure('unsupported', `Unsupported LiveSync vault (${profile.reasons.join(', ')}).`);
      }
      const commonlib = await this.dependencies.acquireCommonlib();
      try {
        return await operation(commonlib, profile);
      } finally {
        await this.dependencies.releaseCommonlib();
      }
    } catch (error) {
      return failure(errorCode(error), errorMessage(error));
    }
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

function isListedMarkdown(
  file: CommonlibFileMetadata,
  prefix: string,
  caseSensitive: boolean
): boolean {
  if (file.datatype !== 'plain' || !isMarkdownPath(file.path)) return false;
  if (prefix === '') return true;
  if (caseSensitive) return file.path.startsWith(prefix);
  return file.path.toLowerCase().startsWith(prefix.toLowerCase());
}

function isSafePrefix(prefix: string): boolean {
  if (prefix === '') return true;
  if (prefix.startsWith('/') || prefix.includes('\\') || prefix.includes('\0') || prefix.startsWith('h:')) return false;
  const segments = (prefix.endsWith('/') ? prefix.slice(0, -1) : prefix).split('/');
  if (segments.some((segment) => segment === '_local' || segment === '_design')) return false;
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function isMarkdownPath(path: string): boolean {
  return path.endsWith('.md') && isSafePrefix(path);
}

function utf8Bytes(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

function contentTooLarge(content: string): VaultResult<never> | undefined {
  if (utf8Bytes(content) > VAULT_LIMITS.maxWriteBytes) {
    return failure('too_large', 'File exceeds the write size limit.');
  }
  return undefined;
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
  if (error && typeof error === 'object' && 'code' in error) {
    const code = error.code;
    if (
      code === 'unsupported'
      || code === 'too_large'
      || code === 'not_found'
      || code === 'unavailable'
      || code === 'conflict'
    ) {
      return code;
    }
  }
  if (error && typeof error === 'object' && 'status' in error) {
    if (error.status === 404) return 'not_found';
    if (error.status === 409) return 'conflict';
    if (error.status === 503) return 'unavailable';
  }
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('unsupported LiveSync')) return 'unsupported';
  return 'internal';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Vault operation failed.';
}
