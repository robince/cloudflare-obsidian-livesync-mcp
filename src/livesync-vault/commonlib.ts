import {
  DirectFileManipulator,
  type DirectFileManipulatorOptions,
} from '@vrtmrz/livesync-commonlib';

import { IN_PROCESS_COUCH_ORIGIN } from './in-process-couch-fetch';
import type { VaultProfileInspection } from './profile';

export const COMMONLIB_VERSION = '0.1.19';

type LoadedEntry = Exclude<Awaited<ReturnType<DirectFileManipulator['get']>>, false>;
type CommonlibPath = Parameters<DirectFileManipulator['get']>[0];
export interface CommonlibFile {
  content: string;
  revision: string;
}

export class CommonlibFacade {
  private readonly manipulator: DirectFileManipulator;

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
      // Reading existing, unobfuscated document IDs and chunks does not depend
      // on the producer's hash algorithm. The pure-JS manager avoids dynamic
      // WebAssembly compilation in workerd. No write API is exposed.
      hashAlg: 'mixed-purejs',
    };
    this.manipulator = new DirectFileManipulator(options, { fetch });
  }

  async ready(): Promise<void> {
    await this.manipulator.ready.promise;
  }

  async read(path: string): Promise<CommonlibFile | false> {
    await this.ready();
    const entry = await this.manipulator.get(path as CommonlibPath);
    if (!entry || !entry._rev) return false;
    return { content: entryData(entry), revision: entry._rev };
  }

  async close(): Promise<void> {
    await this.manipulator.close();
  }
}

function entryData(entry: LoadedEntry): string {
  return Array.isArray(entry.data) ? entry.data.join('') : entry.data;
}
