import {
  DirectFileManipulator,
  type DirectFileManipulatorOptions,
} from '@vrtmrz/livesync-commonlib';

import { IN_PROCESS_COUCH_ORIGIN } from './in-process-couch-fetch';
import type { VaultProfileInspection } from './profile';

export const COMMONLIB_VERSION = '0.1.19';

type CommonlibPath = Parameters<DirectFileManipulator['get']>[0];
type CommonlibDocumentId = Awaited<ReturnType<DirectFileManipulator['path2id']>>;
type EnumeratedEntry = DirectFileManipulator extends {
  enumerateAllNormalDocs: (opt: { metaOnly: boolean }) => AsyncGenerator<infer T>;
} ? T : never;

type RawNote = {
  _id: string;
  _rev: string;
  path?: unknown;
  type?: unknown;
  datatype?: unknown;
  deleted?: unknown;
  _deleted?: unknown;
  children?: unknown;
  eden?: unknown;
  size?: unknown;
  ctime?: unknown;
};

export interface CommonlibFile {
  content: string;
  revision: string;
}

export interface CommonlibFileMetadata {
  id: string;
  path: string;
  revision: string;
  datatype: string;
  size?: number;
  ctime?: number;
}

export class CommonlibFacade {
  private readonly manipulator: DirectFileManipulator;
  private stoppedChangeFeed = false;

  constructor(
    databaseName: string,
    fetch: typeof globalThis.fetch,
    profile: VaultProfileInspection
  ) {
    if (!profile.supported) {
      throw new Error(`unsupported LiveSync profile (${profile.reasons.join(', ')})`);
    }
    const options: DirectFileManipulatorOptions = {
      url: IN_PROCESS_COUCH_ORIGIN,
      database: databaseName,
      username: 'in-process',
      password: 'not-a-credential',
      passphrase: undefined,
      obfuscatePassphrase: undefined,
      enableCompression: profile.enableCompression,
      handleFilenameCaseSensitive: profile.handleFilenameCaseSensitive,
      hashAlg: profile.hashAlg,
    };
    this.manipulator = new DirectFileManipulator(options, { fetch });
  }

  async ready(): Promise<void> {
    await this.manipulator.ready.promise;
    this.stopChangeFeed();
  }

  async *enumerate(): AsyncGenerator<CommonlibFileMetadata> {
    await this.ready();
    for await (const entry of this.manipulator.enumerateAllNormalDocs({ metaOnly: true })) {
      const metadata = listedMetadata(entry);
      if (metadata) yield metadata;
    }
  }

  async inspect(path: string): Promise<CommonlibFileMetadata | false> {
    await this.ready();
    const entry = await this.rawNote(path);
    if (!entry) return false;
    return {
      id: String(entry._id),
      path: typeof entry.path === 'string' ? entry.path : path,
      revision: entry._rev,
      datatype: noteDatatype(entry),
      size: typeof entry.size === 'number' ? entry.size : undefined,
      ctime: typeof entry.ctime === 'number' ? entry.ctime : undefined,
    };
  }

  async read(path: string, maxBytes: number): Promise<CommonlibFile | false> {
    await this.ready();
    const entry = await this.rawNote(path);
    if (!entry) return false;
    if (noteDatatype(entry) !== 'plain') {
      throw Object.assign(new Error('unsupported LiveSync note type'), { code: 'unsupported' });
    }
    const children = entry.children;
    if (!Array.isArray(children) || !children.every((id) => typeof id === 'string')) {
      throw Object.assign(new Error('unsupported LiveSync note format'), { code: 'unsupported' });
    }

    const encoder = new TextEncoder();
    const pieces: string[] = [];
    let bytes = 0;
    for (const childId of children) {
      const inline = inlineChunk(entry.eden, childId);
      const piece = inline ?? await this.rawChunk(childId);
      if (piece === false) return false;
      bytes += encoder.encode(piece).byteLength;
      if (bytes > maxBytes) {
        throw Object.assign(new Error('LiveSync note exceeds the read size limit'), { code: 'too_large' });
      }
      pieces.push(piece);
    }
    return { content: pieces.join(''), revision: entry._rev };
  }

  async write(
    path: string,
    content: string,
    info: { ctime: number; mtime: number; size: number },
    expectedRevision?: string
  ): Promise<{ revision: string } | false> {
    await this.ready();
    const documentId = await this.manipulator.path2id(path as CommonlibPath);
    const note = {
      _id: documentId,
      path: path as CommonlibPath,
      data: new Blob([content], { type: 'text/plain' }),
      ctime: info.ctime,
      mtime: info.mtime,
      size: info.size,
      type: 'plain' as const,
      datatype: 'plain' as const,
      eden: {},
      children: [] as string[],
    };
    const db = this.manipulator.liveSyncLocalDB;
    try {
      let baseRevision = expectedRevision;
      if (baseRevision === undefined) {
        const existing = await db.getDBEntryMeta(path as CommonlibPath, undefined, true);
        if (existing && !isDeleted(existing)) return false;
        baseRevision = existing === false ? undefined : existing._rev;
      }
      // Commonlib owns chunking and serialization. Its live-base writer uses a
      // normal PouchDB put. No revision is create-only; a tombstone revision
      // atomically revives the path in the same way as a host CREATE event.
      const result = await db.putDBEntryWithLiveBaseRevision(
        note,
        baseRevision as string,
      );
      if (!result || typeof result.rev !== 'string') return false;
      return { revision: result.rev };
    } catch (error) {
      if (isConflict(error) || isMissing(error)) return false;
      throw error;
    }
  }

  async remove(path: string, expectedRevision: string): Promise<{ revision: string } | false> {
    await this.ready();
    const id = await this.manipulator.path2id(path as CommonlibPath);
    try {
      const current = await this.manipulator.liveSyncLocalDB.getRaw(id);
      if (!current || current._rev !== expectedRevision) return false;
      const tombstone = { ...current, deleted: true, mtime: Date.now() } as typeof current & { deleted: boolean; _deleted?: boolean };
      delete tombstone._deleted;
      const result = await this.manipulator.liveSyncLocalDB.putRaw(tombstone);
      if (!result?.rev) return false;
      return { revision: result.rev };
    } catch (error) {
      if (isConflict(error) || isMissing(error)) return false;
      throw error;
    }
  }

  async documentId(path: string): Promise<string> {
    await this.ready();
    return this.manipulator.path2id(path as CommonlibPath);
  }

  async close(): Promise<void> {
    this.stopChangeFeed();
    await this.manipulator.close();
  }

  private stopChangeFeed(): void {
    if (this.stoppedChangeFeed) return;
    try {
      const managers = (
        this.manipulator.liveSyncLocalDB as {
          managers?: { changeManager?: { teardown?: () => void } };
        }
      ).managers;
      managers?.changeManager?.teardown?.();
      this.stoppedChangeFeed = true;
    } catch {
      // DirectFileManipulator always starts ChangeManager. If teardown is not
      // yet available, close() still shuts the HTTP adapter down.
    }
  }

  private async rawNote(path: string): Promise<RawNote | false> {
    const id = await this.manipulator.path2id(path as CommonlibPath);
    try {
      const entry = await this.manipulator.liveSyncLocalDB.getRaw(id) as unknown as RawNote;
      if (!entry._rev || isDeleted(entry) || noteDatatype(entry) === 'leaf') return false;
      return entry;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  private async rawChunk(id: string): Promise<string | false> {
    try {
      const chunk = await this.manipulator.liveSyncLocalDB.getRaw(id as CommonlibDocumentId) as unknown as {
        type?: unknown;
        data?: unknown;
      };
      return chunk.type === 'leaf' && typeof chunk.data === 'string' ? chunk.data : false;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }
}

function listedMetadata(entry: EnumeratedEntry): CommonlibFileMetadata | undefined {
  if (typeof entry._id !== 'string' || typeof entry._rev !== 'string' || typeof entry.path !== 'string') {
    return undefined;
  }
  if (isDeleted(entry)) return undefined;
  return {
    id: entry._id,
    path: entry.path,
    revision: entry._rev,
    datatype: noteDatatype(entry),
    size: typeof entry.size === 'number' ? entry.size : undefined,
    ctime: typeof entry.ctime === 'number' ? entry.ctime : undefined,
  };
}

function isDeleted(entry: { deleted?: unknown; _deleted?: unknown }): boolean {
  return entry.deleted === true || entry._deleted === true;
}

function noteDatatype(entry: { datatype?: unknown; type?: unknown }): string {
  if (typeof entry.datatype === 'string') return entry.datatype;
  if (typeof entry.type === 'string') return entry.type;
  return '';
}

function inlineChunk(eden: unknown, id: string): string | undefined {
  if (!eden || typeof eden !== 'object') return undefined;
  const value = (eden as Record<string, unknown>)[id];
  if (!value || typeof value !== 'object') return undefined;
  const data = (value as { data?: unknown }).data;
  return typeof data === 'string' ? data : undefined;
}

function isConflict(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'status' in error && error.status === 409;
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'status' in error && error.status === 404;
}
