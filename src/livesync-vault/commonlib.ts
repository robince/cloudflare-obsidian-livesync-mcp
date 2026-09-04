import {
  DirectFileManipulator,
  type DirectFileManipulatorOptions,
} from '@vrtmrz/livesync-commonlib';
import { decodeBinary } from '@vrtmrz/livesync-commonlib/compat/string_and_binary/convert';
import { compareMTime } from '@vrtmrz/livesync-commonlib/compat/common/utils';
import { TARGET_IS_NEW } from '@vrtmrz/livesync-commonlib/compat/common/models/shared.const.symbols';

import { IN_PROCESS_COUCH_ORIGIN } from './in-process-couch-fetch';
import type { VaultProfileInspection } from './profile';
import { VAULT_LIMITS } from '@cloudflare-obsidian-livesync/contracts';
import { livesyncConflict, reconciledConflict, throwVaultError } from './conflicts';

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
  mtime?: unknown;
  _conflicts?: string[];
  _revs_info?: { rev: string; status: string }[];
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
  mtime?: number;
  unresolvedVersions?: number;
  deleted?: boolean;
}

export interface CommonlibBinaryFile {
  content: Uint8Array;
  revision: string;
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
      mtime: typeof entry.mtime === 'number' ? entry.mtime : undefined,
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

  async readBinary(path: string, maxBytes: number): Promise<CommonlibBinaryFile | false> {
    await this.ready();
    const entry = await this.rawNote(path);
    if (!entry) return false;
    if (noteDatatype(entry) !== 'newnote') {
      throw Object.assign(new Error('unsupported LiveSync attachment type'), { code: 'unsupported' });
    }
    const children = entry.children;
    if (!Array.isArray(children) || !children.every((id) => typeof id === 'string')) {
      throw Object.assign(new Error('unsupported LiveSync attachment format'), { code: 'unsupported' });
    }

    const pieces: Uint8Array[] = [];
    let bytes = 0;
    for (const childId of children) {
      const encoded = inlineChunk(entry.eden, childId) ?? await this.rawChunk(childId);
      if (encoded === false) return false;
      const piece = new Uint8Array(decodeBinary(encoded));
      bytes += piece.byteLength;
      if (bytes > maxBytes) {
        throw Object.assign(new Error('LiveSync attachment exceeds the read size limit'), { code: 'too_large' });
      }
      pieces.push(piece);
    }
    const content = new Uint8Array(bytes);
    let offset = 0;
    for (const piece of pieces) {
      content.set(piece, offset);
      offset += piece.byteLength;
    }
    return { content, revision: entry._rev };
  }

  async write(
    path: string,
    content: string,
    info: { ctime: number; mtime: number; size: number },
    expectedRevision?: string
  ): Promise<{ revision: string } | false> {
    await this.ready();
    await this.assertUnconflicted(path);
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
    await this.assertUnconflicted(path);
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

  /** Metadata only: never resolves a conflict on a read/list path. */
  async conflictVersions(path: string): Promise<number> {
    await this.ready();
    const entry = await this.conflictNote(path);
    return entry ? 1 + (entry._conflicts?.length ?? 0) : 0;
  }

  private async assertUnconflicted(path: string): Promise<void> {
    const versions = await this.conflictVersions(path);
    if (versions > 1) throwVaultError(livesyncConflict(path, versions));
  }

  /** Called only from a write-authorized semantic operation, never raw replication. */
  async reconcileBeforeMutation(path: string): Promise<void> {
    await this.ready();
    let changed = false;
    const db = this.manipulator.liveSyncLocalDB;
    for (let pair = 0; pair < 8; pair++) {
      const observed = await this.conflictNote(path);
      const versions = observed ? 1 + (observed._conflicts?.length ?? 0) : 0;
      if (!observed || versions < 2) {
        if (changed) throwVaultError(reconciledConflict(path, versions));
        return;
      }
      const stop: () => never = () => throwVaultError(changed
        ? reconciledConflict(path, versions) : livesyncConflict(path, versions));
      // No binary decoding policy and no unbounded Commonlib chunk hydration.
      if (!path.endsWith('.md') || noteDatatype(observed) !== 'plain') stop();
      if (versions > 16) stop();
      try {
        // Validate every live leaf before asking Commonlib to classify a pair.
        // Missing history/chunks must not be treated as empty or identical data.
        for (const rev of [observed._rev, ...(observed._conflicts ?? [])]) {
          const leaf = await db.getRaw(observed._id as CommonlibDocumentId, { rev, revs_info: true });
          if (noteDatatype(leaf) !== 'plain' || isDeleted(leaf)) stop();
          await this.validateMergeBody(leaf);
          const shared = new Set(observed._revs_info?.filter(r => r.status === 'available').map(r => r.rev));
          const base = leaf._revs_info?.filter(r => r.status === 'available' && shared.has(r.rev))
            .sort((a, b) => parseInt(b.rev) - parseInt(a.rev))[0];
          if (base && base.rev !== rev) {
            await this.validateMergeBody(await db.getRaw(observed._id as CommonlibDocumentId, { rev: base.rev }));
          }
        }
        const result = await db.tryAutoMerge(path as CommonlibPath, true);
        if ('ok' in result) stop();
        const fresh = await this.conflictNote(path);
        if (!sameTree(observed, fresh)) stop();
        let losingRev: string;
        let winnerRev = observed._rev;
        if ('result' in result) {
          losingRev = result.conflictedRev;
          if (!observed._conflicts?.includes(losingRev)) stop();
          // Commonlib finds the nearest *available shared* ancestor. Validate
          // that body's chunks as well; never infer ancestry from generation.
          const other = await db.getRaw(observed._id as CommonlibDocumentId, { rev: losingRev, revs_info: true });
          const available = new Set(observed._revs_info?.filter(r => r.status === 'available').map(r => r.rev));
          const base = other._revs_info?.filter(r => r.status === 'available' && available.has(r.rev))
            .sort((a, b) => parseInt(b.rev) - parseInt(a.rev))[0];
          if (!base) stop();
          await this.validateMergeBody(await db.getRaw(observed._id as CommonlibDocumentId, { rev: base!.rev }));
          if (new TextEncoder().encode(result.result).byteLength > VAULT_LIMITS.maxWriteBytes) stop();
          // Deliberately bypass public write's no-conflicts guard, but retain
          // Commonlib's ordinary exact-revision CAS, never a forced branch put.
          const written = await db.putDBEntryWithLiveBaseRevision({
            _id: observed._id as CommonlibDocumentId, path: path as CommonlibPath,
            data: new Blob([result.result], { type: 'text/plain' }),
            type: 'plain', datatype: 'plain', children: [], eden: {},
            ctime: typeof observed.ctime === 'number' ? observed.ctime : Date.now(),
            mtime: Date.now(), size: new TextEncoder().encode(result.result).byteLength,
          }, observed._rev);
          if (!written) stop();
          winnerRev = written.rev;
          changed = true;
        } else {
          if (!result.leftLeaf || !result.rightLeaf
            || result.leftRev !== observed._rev
            || result.leftLeaf.data !== result.rightLeaf.data
            || result.leftLeaf.deleted !== result.rightLeaf.deleted) stop();
          // Match the host's duplicate policy only after exact byte equality.
          losingRev = compareMTime(result.leftLeaf.mtime, result.rightLeaf.mtime) === TARGET_IS_NEW
            ? result.leftRev : result.rightRev;
        }
        const beforeDelete = await this.conflictNote(path);
        const expected = { ...observed, _rev: winnerRev };
        if (!sameTree(expected, beforeDelete) || !beforeDelete
          || ![beforeDelete._rev, ...(beforeDelete._conflicts ?? [])].includes(losingRev)) stop();
        await db.removeRaw(observed._id as CommonlibDocumentId, losingRev);
        changed = true;
      } catch (error) {
        if (error instanceof Error && 'resolution' in error) throw error;
        // A failed CAS, unavailable body, or interrupted resolution preserves
        // remaining leaves. Never apply the user's original mutation.
        const remaining = await this.conflictVersions(path);
        throwVaultError(changed ? reconciledConflict(path, remaining) : livesyncConflict(path, remaining));
      }
    }
    throwVaultError(reconciledConflict(path, await this.conflictVersions(path)));
  }

  private async validateMergeBody(entry: RawNote): Promise<void> {
    if (isDeleted(entry) || !Array.isArray(entry.children) || entry.children.length > 1024) throw new Error('Unreadable merge body');
    let bytes = 0;
    for (const id of entry.children) {
      if (typeof id !== 'string') throw new Error('Invalid chunk');
      const piece = inlineChunk(entry.eden, id) ?? await this.rawChunk(id);
      if (piece === false) throw new Error('Missing merge chunk');
      bytes += new TextEncoder().encode(piece).byteLength;
      if (bytes > VAULT_LIMITS.maxReadBytes) throw new Error('Merge body too large');
    }
  }

  private async conflictNote(path: string): Promise<RawNote | false> {
    const id = await this.manipulator.path2id(path as CommonlibPath);
    try {
      return await this.manipulator.liveSyncLocalDB.getRaw(id, { conflicts: true, revs_info: true });
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
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
      const entry = await this.manipulator.liveSyncLocalDB.getRaw(id, { conflicts: true, revs_info: true }) as unknown as RawNote;
      if (entry._conflicts?.length) throwVaultError(livesyncConflict(path, entry._conflicts.length + 1));
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
  return {
    id: entry._id,
    path: entry.path,
    revision: entry._rev,
    datatype: noteDatatype(entry),
    size: typeof entry.size === 'number' ? entry.size : undefined,
    ctime: typeof entry.ctime === 'number' ? entry.ctime : undefined,
    mtime: typeof entry.mtime === 'number' ? entry.mtime : undefined,
    deleted: isDeleted(entry),
  };
}

function sameTree(left: RawNote, right: RawNote | false): boolean {
  return !!right && left._rev === right._rev
    && JSON.stringify([...(left._conflicts ?? [])].sort()) === JSON.stringify([...(right._conflicts ?? [])].sort());
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
