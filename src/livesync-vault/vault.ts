import {
  appendVaultFileRequestSchema,
  CONTRACT_VERSION,
  createVaultFileRequestSchema,
  deleteVaultFileRequestSchema,
  listVaultAttachmentsRequestSchema,
  listVaultFilesRequestSchema,
  patchVaultFileRequestSchema,
  patchVaultFrontmatterRequestSchema,
  readVaultAttachmentRequestSchema,
  readVaultFileRequestSchema,
  readVaultFrontmatterRequestSchema,
  updateVaultFileRequestSchema,
  VAULT_LIMITS,
  type AppendVaultFileRequest,
  type CreateVaultFileRequest,
  type DeleteVaultFileRequest,
  type ListVaultAttachmentsData,
  type ListVaultAttachmentsRequest,
  type ListVaultFilesRequest,
  type ListVaultFilesData,
  type PatchVaultFileData,
  type PatchVaultFileRequest,
  type PatchVaultFrontmatterData,
  type PatchVaultFrontmatterRequest,
  type ReadVaultAttachmentData,
  type ReadVaultAttachmentRequest,
  type ReadVaultFileRequest,
  type ReadVaultFileData,
  type ReadVaultFrontmatterData,
  type ReadVaultFrontmatterRequest,
  type UpdateVaultFileRequest,
  type VaultErrorCode,
  type VaultResult,
  type VaultStatusData,
  type WriteVaultFileData,
} from '@cloudflare-obsidian-livesync/contracts';

import type { CommonlibFacade, CommonlibFileMetadata } from './commonlib';
import { patchFrontmatter as applyFrontmatterPatch, readFrontmatter as parseFrontmatter } from './frontmatter';
import type { VaultProfileInspection } from './profile';

type VaultDependencies = {
  profile: () => Promise<VaultProfileInspection>;
  acquireCommonlib: (
    profile: Extract<VaultProfileInspection, { supported: true }>,
  ) => Promise<CommonlibFacade>;
  releaseCommonlib: (commonlib: CommonlibFacade) => Promise<void>;
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

  async listAttachments(request: ListVaultAttachmentsRequest): Promise<VaultResult<ListVaultAttachmentsData>> {
    const parsed = listVaultAttachmentsRequestSchema.safeParse(request);
    if (!parsed.success) return failure('invalid_input', 'Invalid attachment listing request.');

    const prefix = parsed.data.prefix ?? '';
    if (!isSafePrefix(prefix)) return failure('invalid_input', 'Prefix must be a safe relative path.');
    const cursor = decodeCursor(parsed.data.cursor, prefix);
    if (parsed.data.cursor && !cursor) return failure('invalid_input', 'Cursor does not match this prefix.');
    const limit = parsed.data.limit ?? VAULT_LIMITS.defaultListLimit;

    return this.withCommonlib(async (commonlib, profile) => {
      const page: CommonlibFileMetadata[] = [];
      let extra = false;
      for await (const file of commonlib.enumerate()) {
        if (!isListedAttachment(file, prefix, profile.handleFilenameCaseSensitive)) continue;
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
        attachments: page.map((file) => ({ ...toPublicFile(file), mimeType: mimeType(file.path) })),
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
      const file = await commonlib.read(parsed.data.path, VAULT_LIMITS.maxReadBytes);
      if (!file) return failure('not_found', 'File not found.');
      return success({ path: parsed.data.path, revision: file.revision, content: file.content });
    });
  }

  async readAttachment(request: ReadVaultAttachmentRequest): Promise<VaultResult<ReadVaultAttachmentData>> {
    const parsed = readVaultAttachmentRequestSchema.safeParse(request);
    if (!parsed.success || !isAttachmentPath(parsed.data?.path ?? '')) {
      return failure('invalid_input', 'Path must be a safe relative non-Markdown file.');
    }

    return this.withCommonlib(async (commonlib) => {
      const meta = await commonlib.inspect(parsed.data.path);
      if (!meta) return failure('not_found', 'Attachment not found.');
      if (meta.datatype !== 'plain' && meta.datatype !== 'newnote') {
        return failure('unsupported', 'Unsupported LiveSync attachment type.');
      }
      if (typeof meta.size === 'number' && meta.size > VAULT_LIMITS.maxAttachmentReadBytes) {
        return failure('too_large', 'Attachment exceeds the read size limit.');
      }
      let bytes: Uint8Array;
      let revision: string;
      if (meta.datatype === 'plain') {
        const file = await commonlib.read(parsed.data.path, VAULT_LIMITS.maxAttachmentReadBytes);
        if (!file) return failure('not_found', 'Attachment not found.');
        bytes = new TextEncoder().encode(file.content);
        revision = file.revision;
      } else {
        const file = await commonlib.readBinary(parsed.data.path, VAULT_LIMITS.maxAttachmentReadBytes);
        if (!file) return failure('not_found', 'Attachment not found.');
        bytes = file.content;
        revision = file.revision;
      }
      return success({
        path: meta.path,
        revision,
        mimeType: mimeType(meta.path),
        sizeBytes: bytes.byteLength,
        contentBase64: base64(bytes),
      });
    });
  }

  async readFrontmatter(request: ReadVaultFrontmatterRequest): Promise<VaultResult<ReadVaultFrontmatterData>> {
    const parsed = readVaultFrontmatterRequestSchema.safeParse(request);
    if (!parsed.success || !isMarkdownPath(parsed.data?.path ?? '')) {
      return failure('invalid_input', 'Path must be a safe relative Markdown file.');
    }
    return this.withCommonlib(async (commonlib) => {
      const file = await commonlib.read(parsed.data.path, VAULT_LIMITS.maxReadBytes);
      if (!file) return failure('not_found', 'File not found.');
      return success({ path: parsed.data.path, revision: file.revision, frontmatter: parseFrontmatter(file.content) });
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
        existing.path,
        parsed.data.content,
        {
          ctime: existing.ctime ?? Date.now(),
          mtime: Date.now(),
          size: utf8Bytes(parsed.data.content),
        },
        parsed.data.expectedRevision
      );
      if (!written) return failure('conflict', 'The file was modified by another client.');
      return success({ path: existing.path, revision: written.revision });
    });
  }

  async append(request: AppendVaultFileRequest): Promise<VaultResult<WriteVaultFileData>> {
    const parsed = appendVaultFileRequestSchema.safeParse(request);
    if (!parsed.success || !isMarkdownPath(parsed.data?.path ?? '')) {
      return failure('invalid_input', 'Path must be a safe relative Markdown file.');
    }
    return this.transformMarkdown(parsed.data.path, parsed.data.expectedRevision, (content) => content + parsed.data.content);
  }

  async patch(request: PatchVaultFileRequest): Promise<VaultResult<PatchVaultFileData>> {
    const parsed = patchVaultFileRequestSchema.safeParse(request);
    if (!parsed.success || !isMarkdownPath(parsed.data?.path ?? '')) {
      return failure('invalid_input', 'Invalid Markdown patch request.');
    }
    let replacements = 0;
    const result = await this.transformMarkdown(parsed.data.path, parsed.data.expectedRevision, (content) => {
      replacements = content.split(parsed.data.oldText).length - 1;
      if (replacements === 0) throw inputError('oldText was not found in the file.');
      if (!parsed.data.replaceAll && replacements !== 1) {
        throw inputError('oldText must match exactly once unless replaceAll is true.');
      }
      return content.split(parsed.data.oldText).join(parsed.data.newText);
    });
    return result.ok ? success({ ...result.data, replacements }) : result;
  }

  async patchFrontmatter(request: PatchVaultFrontmatterRequest): Promise<VaultResult<PatchVaultFrontmatterData>> {
    const parsed = patchVaultFrontmatterRequestSchema.safeParse(request);
    if (!parsed.success || !isMarkdownPath(parsed.data?.path ?? '')) {
      return failure('invalid_input', 'Invalid frontmatter patch request.');
    }
    let updated: string[] = [];
    let removed: string[] = [];
    const result = await this.transformMarkdown(parsed.data.path, parsed.data.expectedRevision, (content) => {
      const patched = applyFrontmatterPatch(content, parsed.data);
      updated = patched.updated;
      removed = patched.removed;
      return patched.content;
    });
    return result.ok ? success({ ...result.data, updated, removed }) : result;
  }

  async delete(request: DeleteVaultFileRequest): Promise<VaultResult<WriteVaultFileData>> {
    const parsed = deleteVaultFileRequestSchema.safeParse(request);
    if (!parsed.success || !isMarkdownPath(parsed.data?.path ?? '')) {
      return failure('invalid_input', 'Path must be a safe relative Markdown file.');
    }

    return this.withCommonlib(async (commonlib) => {
      const existing = await commonlib.inspect(parsed.data.path);
      if (!existing) return failure('not_found', 'File not found.');
      if (existing.datatype !== 'plain') {
        return failure('unsupported', 'Only plain Markdown notes can be deleted.');
      }
      if (existing.revision !== parsed.data.expectedRevision) {
        return failure('conflict', 'The file was modified by another client.');
      }
      const removed = await commonlib.remove(existing.path, parsed.data.expectedRevision);
      if (!removed) return failure('conflict', 'The file was modified by another client.');
      return success({ path: existing.path, revision: removed.revision });
    });
  }

  private async transformMarkdown(
    path: string,
    expectedRevision: string,
    transform: (content: string) => string,
  ): Promise<VaultResult<WriteVaultFileData>> {
    return this.withCommonlib(async (commonlib) => {
      const existing = await commonlib.inspect(path);
      if (!existing) return failure('not_found', 'File not found.');
      if (existing.datatype !== 'plain') return failure('unsupported', 'Only plain Markdown notes can be updated.');
      const file = await commonlib.read(existing.path, VAULT_LIMITS.maxReadBytes);
      if (!file) return failure('not_found', 'File not found.');
      if (file.revision !== expectedRevision) return failure('conflict', 'The file was modified by another client.');
      const content = transform(file.content);
      if (content === file.content) return success({ path: existing.path, revision: file.revision });
      const size = utf8Bytes(content);
      if (size > VAULT_LIMITS.maxWriteBytes) return failure('too_large', 'File exceeds the write size limit.');
      const written = await commonlib.write(
        existing.path,
        content,
        { ctime: existing.ctime ?? Date.now(), mtime: Date.now(), size },
        expectedRevision,
      );
      if (!written) return failure('conflict', 'The file was modified by another client.');
      return success({ path: existing.path, revision: written.revision });
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
      const commonlib = await this.dependencies.acquireCommonlib(profile);
      try {
        return await operation(commonlib, profile);
      } finally {
        await this.dependencies.releaseCommonlib(commonlib);
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
  return {
    path: file.path,
    revision: file.revision,
    ...(file.size === undefined ? {} : { sizeBytes: file.size }),
    ...(file.ctime === undefined ? {} : { createdAt: file.ctime }),
    ...(file.mtime === undefined ? {} : { modifiedAt: file.mtime }),
  };
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

function isListedAttachment(file: CommonlibFileMetadata, prefix: string, caseSensitive: boolean): boolean {
  if ((file.datatype !== 'plain' && file.datatype !== 'newnote') || !isAttachmentPath(file.path)) return false;
  if (prefix === '') return true;
  return caseSensitive
    ? file.path.startsWith(prefix)
    : file.path.toLowerCase().startsWith(prefix.toLowerCase());
}

function isSafePrefix(prefix: string): boolean {
  if (prefix === '') return true;
  if (prefix.startsWith('/') || prefix.includes('\\') || prefix.includes('\0') || prefix.includes(':')) return false;
  const segments = (prefix.endsWith('/') ? prefix.slice(0, -1) : prefix).split('/');
  if (segments.some((segment) => segment === '_local' || segment === '_design')) return false;
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function isMarkdownPath(path: string): boolean {
  return path.endsWith('.md') && isSafePrefix(path);
}

function isAttachmentPath(path: string): boolean {
  return path !== '' && !path.toLowerCase().endsWith('.md') && isSafePrefix(path);
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

function inputError(message: string): Error & { code: 'invalid_input' } {
  return Object.assign(new Error(message), { code: 'invalid_input' as const });
}

function base64(content: Uint8Array): string {
  let binary = '';
  for (const byte of content) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function mimeType(path: string): string {
  const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
  return MIME_TYPES[extension] ?? 'application/octet-stream';
}

const MIME_TYPES: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  canvas: 'application/json',
  csv: 'text/csv',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  json: 'application/json',
  m4a: 'audio/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  wav: 'audio/wav',
  webp: 'image/webp',
  zip: 'application/zip',
};

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
      || code === 'invalid_input'
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
