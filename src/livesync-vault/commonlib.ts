import {
  DirectFileManipulator,
  type DirectFileManipulatorOptions,
} from '@vrtmrz/livesync-commonlib';

import { IN_PROCESS_COUCH_ORIGIN } from './in-process-couch-fetch';
import type { VaultProfileInspection } from './profile';

export const COMMONLIB_VERSION = '0.1.19';

type LoadedEntry = Exclude<Awaited<ReturnType<DirectFileManipulator['get']>>, false>;
type CommonlibPath = Parameters<DirectFileManipulator['get']>[0];
type EnumeratedEntry = DirectFileManipulator extends {
  enumerateAllNormalDocs: (opt: { metaOnly: boolean }) => AsyncGenerator<infer T>;
} ? T : never;

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
      // mixed-purejs avoids WASM in workerd. Obsidian still replicates MCP
      // notes because chunks are fetched by the stored child IDs.
      hashAlg: 'mixed-purejs',
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
    const entry = await this.manipulator.get(path as CommonlibPath, true);
    if (!entry || !entry._rev || isDeleted(entry)) return false;
    return {
      id: String(entry._id),
      path,
      revision: entry._rev,
      datatype: noteDatatype(entry),
      size: typeof entry.size === 'number' ? entry.size : undefined,
      ctime: typeof entry.ctime === 'number' ? entry.ctime : undefined,
    };
  }

  async read(path: string): Promise<CommonlibFile | false> {
    await this.ready();
    const entry = await this.manipulator.get(path as CommonlibPath);
    if (!entry || !entry._rev || isDeleted(entry)) return false;
    if (noteDatatype(entry) !== 'plain') {
      throw Object.assign(new Error('unsupported LiveSync note type'), { code: 'unsupported' });
    }
    return { content: entryData(entry), revision: entry._rev };
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
    const result = expectedRevision
      ? await db.putDBEntryWithLiveBaseRevision(note, expectedRevision)
      : await db.putDBEntry(note);
    if (!result || typeof result.rev !== 'string') return false;
    return { revision: result.rev };
  }

  async remove(path: string): Promise<boolean> {
    await this.ready();
    return this.manipulator.liveSyncLocalDB.deleteDBEntry(path as CommonlibPath);
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

function entryData(entry: LoadedEntry): string {
  return Array.isArray(entry.data) ? entry.data.join('') : entry.data;
}
