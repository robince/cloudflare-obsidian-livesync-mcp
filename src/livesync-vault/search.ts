import type PouchDB from 'pouchdb-core';
import {
  searchVaultFilesRequestSchema,
  VAULT_LIMITS,
  type SearchVaultFilesData,
  type SearchVaultFilesRequest,
  type VaultResult,
} from '@cloudflare-obsidian-livesync/contracts';

import type { JsonObject } from '../types';
import type { CommonlibFacade } from './commonlib';
import type { VaultProfileInspection } from './profile';

const SEARCH_SCHEMA_VERSION = '2';
const SEARCH_CATCHUP_MS = 3_000;
const SEARCH_CHANGES_PAGE = 100;

type SearchDatabase = PouchDB.Database<JsonObject> & { id(): Promise<string> };

type SearchDependencies = {
  storage: DurableObjectStorage;
  database: () => SearchDatabase;
  profile: () => Promise<VaultProfileInspection>;
  acquireCommonlib: (
    profile: Extract<VaultProfileInspection, { supported: true }>,
  ) => Promise<CommonlibFacade>;
};

type SearchDocumentRow = {
  fts_rowid: number;
  path: string;
  revision: string;
  unresolved_versions: number;
  status: 'indexed' | 'excluded';
  fts_present: number;
};

type SearchRow = {
  path: string;
  revision: string;
  unresolved_versions: number;
  snippet: string;
};

type CatchUpResult = 'ready' | 'catching_up' | 'pending_chunks';

export class LiveSyncSearch {
  constructor(private readonly dependencies: SearchDependencies) {}

  async search(request: SearchVaultFilesRequest): Promise<VaultResult<SearchVaultFilesData>> {
    const parsed = searchVaultFilesRequestSchema.safeParse(request);
    if (!parsed.success) return failure('invalid_input', 'Invalid search request.');
    const pathPrefix = parsed.data.pathPrefix ?? '';
    if (!isSafePrefix(pathPrefix)) return failure('invalid_input', 'pathPrefix must be a safe relative path prefix.');

    try {
      const profile = await this.dependencies.profile();
      if (!profile.supported) {
        return failure('unsupported', `Unsupported LiveSync vault (${profile.reasons.join(', ')}).`);
      }
      this.initializeSchema();
      const db = this.dependencies.database();
      const databaseId = await db.id();
      this.resetForDatabase(databaseId);
      const target = sequence((await db.info()).update_seq);

      let commonlib: CommonlibFacade | undefined;
      try {
        const catchUp = await this.catchUp(db, target, Date.now() + SEARCH_CATCHUP_MS, async () => {
          commonlib ??= await this.dependencies.acquireCommonlib(profile);
          return commonlib;
        });
        if (catchUp === 'pending_chunks') {
          return failure('unavailable', 'Search is waiting for referenced LiveSync chunks. Retry after replication completes.');
        }
        if (catchUp === 'catching_up') {
          return failure('unavailable', 'Search index is catching up with LiveSync changes. Retry search_files.');
        }
        return {
          ok: true,
          data: this.query(
            parsed.data.query,
            pathPrefix,
            parsed.data.limit,
            profile.handleFilenameCaseSensitive,
          ),
        };
      } finally {
        if (commonlib) await commonlib.close();
      }
    } catch (error) {
      console.error(JSON.stringify({ message: 'search_files failed', error: errorMessage(error) }));
      return failure('internal', 'Search is temporarily unavailable.');
    }
  }

  invalidatePurgedDocuments(documentIds: string[]): void {
    if (!this.hasSchema()) return;
    this.dependencies.storage.transactionSync(() => {
      for (const documentId of documentIds) this.deleteDocument(documentId);
      this.setState('checkpoint', '0');
    });
  }

  private initializeSchema(): void {
    const sql = this.dependencies.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS livesync_search_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
    const version = this.state('schema_version');
    if (version !== SEARCH_SCHEMA_VERSION) {
      sql.exec('DROP TABLE IF EXISTS livesync_search_fts');
      sql.exec('DROP TABLE IF EXISTS livesync_search_documents');
      sql.exec('DELETE FROM livesync_search_meta');
    }
    sql.exec(`CREATE TABLE IF NOT EXISTS livesync_search_documents (
      fts_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id TEXT NOT NULL UNIQUE,
      path TEXT NOT NULL,
      path_folded TEXT NOT NULL,
      revision TEXT NOT NULL,
      unresolved_versions INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('indexed', 'excluded')),
      exclusion_reason TEXT
    )`);
    sql.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS livesync_search_fts USING fts5(
      path,
      title,
      content,
      tokenize='unicode61 remove_diacritics 2'
    )`);
    this.setState('schema_version', SEARCH_SCHEMA_VERSION);
    if (this.state('checkpoint') === undefined) this.setState('checkpoint', '0');
  }

  private hasSchema(): boolean {
    return this.dependencies.storage.sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE name='livesync_search_meta'")
      .toArray().length > 0;
  }

  private resetForDatabase(databaseId: string): void {
    if (this.state('database_id') === databaseId) return;
    this.dependencies.storage.transactionSync(() => {
      this.dependencies.storage.sql.exec('DELETE FROM livesync_search_fts');
      this.dependencies.storage.sql.exec('DELETE FROM livesync_search_documents');
      this.setState('database_id', databaseId);
      this.setState('checkpoint', '0');
    });
  }

  private async catchUp(
    db: SearchDatabase,
    target: number,
    deadline: number,
    commonlib: () => Promise<CommonlibFacade>,
  ): Promise<CatchUpResult> {
    let checkpoint = this.checkpoint();
    while (checkpoint < target) {
      if (Date.now() >= deadline) return 'catching_up';
      const page = await db.changes<JsonObject>({
        since: checkpoint,
        include_docs: true,
        conflicts: true,
        limit: SEARCH_CHANGES_PAGE,
        return_docs: true,
      } as PouchDB.Core.ChangesOptions);
      if (page.results.length === 0) {
        this.advanceCheckpoint(target);
        checkpoint = target;
        break;
      }
      for (const change of page.results) {
        if (Date.now() >= deadline) return 'catching_up';
        const changeSequence = sequence(change.seq);
        if (changeSequence > target) {
          return 'catching_up';
        }
        const observed = change.doc as JsonObject | undefined;
        if (change.deleted || observed?._deleted === true) {
          this.commitDelete(change.id, changeSequence);
          checkpoint = changeSequence;
          continue;
        }
        if (!observed || typeof observed.path !== 'string') {
          this.commitDelete(change.id, changeSequence);
          checkpoint = changeSequence;
          continue;
        }

        let current: JsonObject;
        try {
          current = await db.get(change.id, { conflicts: true }) as JsonObject;
        } catch (error) {
          if (!isMissing(error)) throw error;
          this.commitDelete(change.id, changeSequence);
          checkpoint = changeSequence;
          continue;
        }
        const path = typeof current.path === 'string' ? current.path : observed.path;
        const revision = typeof current._rev === 'string' ? current._rev : undefined;
        const unresolvedVersions = 1 + (Array.isArray(current._conflicts) ? current._conflicts.length : 0);
        if (!revision || current.deleted === true || current._deleted === true
          || !isSafeMarkdownPath(path) || noteDatatype(current) !== 'plain') {
          this.commitDelete(change.id, changeSequence);
          checkpoint = changeSequence;
          continue;
        }

        const existing = this.document(change.id);
        if (existing?.revision === revision
          && existing.path === path
          && (existing.status === 'excluded' || existing.fts_present === 1)) {
          this.dependencies.storage.transactionSync(() => {
            this.dependencies.storage.sql.exec(
              'UPDATE livesync_search_documents SET unresolved_versions=? WHERE doc_id=?',
              unresolvedVersions,
              change.id,
            );
            this.setState('checkpoint', String(changeSequence));
          });
          checkpoint = changeSequence;
          continue;
        }

        const file = await (await commonlib()).readWinningForSearch(path, VAULT_LIMITS.maxReadBytes);
        if (file.kind === 'pending') return 'pending_chunks';
        if (file.kind === 'missing') {
          this.commitDelete(change.id, changeSequence);
        } else if (file.kind === 'excluded') {
          this.commitExcluded(change.id, path, file.revision, file.unresolvedVersions, file.reason, changeSequence);
        } else {
          this.commitIndexed(change.id, path, file.revision, file.unresolvedVersions, file.content, changeSequence);
        }
        checkpoint = changeSequence;
      }
    }
    return checkpoint >= target ? 'ready' : 'catching_up';
  }

  private query(
    query: string,
    pathPrefix: string,
    requestedLimit: number | undefined,
    caseSensitive: boolean,
  ): SearchVaultFilesData {
    const limit = requestedLimit ?? VAULT_LIMITS.defaultSearchLimit;
    const match = query.trim().split(/\s+/u).map((term) => `"${term.replaceAll('"', '""')}"`).join(' ');
    const prefixColumn = caseSensitive ? 'd.path' : 'd.path_folded';
    const comparablePrefix = caseSensitive ? pathPrefix : pathPrefix.toLowerCase();
    const rows = this.dependencies.storage.sql.exec<SearchRow>(
      `SELECT d.path, d.revision, d.unresolved_versions,
              snippet(livesync_search_fts, -1, '⟦', '⟧', '…', 24) AS snippet
         FROM livesync_search_fts
         JOIN livesync_search_documents d ON d.fts_rowid=livesync_search_fts.rowid
        WHERE livesync_search_fts MATCH ?
          AND d.status='indexed'
          AND (?='' OR instr(${prefixColumn}, ?)=1)
        ORDER BY bm25(livesync_search_fts, 4.0, 8.0, 1.0), d.path ASC
        LIMIT ?`,
      match,
      comparablePrefix,
      comparablePrefix,
      limit + 1,
    ).toArray();
    const unindexedFiles = this.dependencies.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM livesync_search_documents WHERE status='excluded'")
      .one().count;
    const results: SearchVaultFilesData['results'] = [];
    let truncated = rows.length > limit;
    for (const row of rows.slice(0, limit)) {
      const result = {
        path: row.path,
        revision: row.revision,
        snippet: truncateUtf8(row.snippet, VAULT_LIMITS.maxSearchSnippetBytes),
        ...(row.unresolved_versions > 1 ? { unresolvedVersions: row.unresolved_versions } : {}),
      };
      const candidate = {
        results: [...results, result], truncated, incomplete: unindexedFiles > 0, unindexedFiles,
      };
      if (utf8Bytes(JSON.stringify(candidate)) > VAULT_LIMITS.maxSearchResponseBytes) {
        truncated = true;
        break;
      }
      results.push(result);
    }
    return { results, truncated, incomplete: unindexedFiles > 0, unindexedFiles };
  }

  private document(documentId: string): SearchDocumentRow | undefined {
    return this.dependencies.storage.sql.exec<SearchDocumentRow>(
      `SELECT d.fts_rowid, d.path, d.revision, d.unresolved_versions, d.status,
              EXISTS(SELECT 1 FROM livesync_search_fts f WHERE f.rowid=d.fts_rowid) AS fts_present
         FROM livesync_search_documents d WHERE d.doc_id=?`,
      documentId,
    ).toArray()[0];
  }

  private commitIndexed(
    documentId: string,
    path: string,
    revision: string,
    unresolvedVersions: number,
    content: string,
    checkpoint: number,
  ): void {
    this.dependencies.storage.transactionSync(() => {
      const rowId = this.upsertDocument(documentId, path, revision, unresolvedVersions, 'indexed');
      this.dependencies.storage.sql.exec('DELETE FROM livesync_search_fts WHERE rowid=?', rowId);
      this.dependencies.storage.sql.exec(
        'INSERT INTO livesync_search_fts(rowid, path, title, content) VALUES (?, ?, ?, ?)',
        rowId,
        path,
        title(path),
        content,
      );
      this.setState('checkpoint', String(checkpoint));
    });
  }

  private commitExcluded(
    documentId: string,
    path: string,
    revision: string,
    unresolvedVersions: number,
    reason: string,
    checkpoint: number,
  ): void {
    this.dependencies.storage.transactionSync(() => {
      const rowId = this.upsertDocument(documentId, path, revision, unresolvedVersions, 'excluded', reason);
      this.dependencies.storage.sql.exec('DELETE FROM livesync_search_fts WHERE rowid=?', rowId);
      this.setState('checkpoint', String(checkpoint));
    });
  }

  private commitDelete(documentId: string, checkpoint: number): void {
    this.dependencies.storage.transactionSync(() => {
      this.deleteDocument(documentId);
      this.setState('checkpoint', String(checkpoint));
    });
  }

  private deleteDocument(documentId: string): void {
    const row = this.dependencies.storage.sql
      .exec<{ fts_rowid: number }>('SELECT fts_rowid FROM livesync_search_documents WHERE doc_id=?', documentId)
      .toArray()[0];
    if (row) this.dependencies.storage.sql.exec('DELETE FROM livesync_search_fts WHERE rowid=?', row.fts_rowid);
    this.dependencies.storage.sql.exec('DELETE FROM livesync_search_documents WHERE doc_id=?', documentId);
  }

  private upsertDocument(
    documentId: string,
    path: string,
    revision: string,
    unresolvedVersions: number,
    status: 'indexed' | 'excluded',
    reason?: string,
  ): number {
    const existing = this.dependencies.storage.sql
      .exec<{ fts_rowid: number }>('SELECT fts_rowid FROM livesync_search_documents WHERE doc_id=?', documentId)
      .toArray()[0];
    if (existing) {
      this.dependencies.storage.sql.exec(
        `UPDATE livesync_search_documents
            SET path=?, path_folded=?, revision=?, unresolved_versions=?, status=?, exclusion_reason=?
          WHERE doc_id=?`,
        path,
        path.toLowerCase(),
        revision,
        unresolvedVersions,
        status,
        reason ?? null,
        documentId,
      );
      return existing.fts_rowid;
    }
    return this.dependencies.storage.sql.exec<{ fts_rowid: number }>(
      `INSERT INTO livesync_search_documents
        (doc_id, path, path_folded, revision, unresolved_versions, status, exclusion_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING fts_rowid`,
      documentId,
      path,
      path.toLowerCase(),
      revision,
      unresolvedVersions,
      status,
      reason ?? null,
    ).one().fts_rowid;
  }

  private advanceCheckpoint(checkpoint: number): void {
    this.dependencies.storage.transactionSync(() => this.setState('checkpoint', String(checkpoint)));
  }

  private checkpoint(): number {
    return sequence(this.state('checkpoint') ?? '0');
  }

  private state(key: string): string | undefined {
    return this.dependencies.storage.sql
      .exec<{ value: string }>('SELECT value FROM livesync_search_meta WHERE key=?', key)
      .toArray()[0]?.value;
  }

  private setState(key: string, value: string): void {
    this.dependencies.storage.sql.exec(
      `INSERT INTO livesync_search_meta(key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      key,
      value,
    );
  }
}

function failure(code: 'invalid_input' | 'unsupported' | 'unavailable' | 'internal', message: string): VaultResult<never> {
  return { ok: false, error: { code, message } };
}

function sequence(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Unsupported PouchDB update sequence');
  return parsed;
}

function noteDatatype(entry: JsonObject): unknown {
  return entry.datatype ?? entry.type;
}

function title(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name;
}

function isSafePrefix(prefix: string): boolean {
  if (prefix === '') return true;
  if (prefix.startsWith('/') || prefix.includes('\\') || prefix.includes('\0') || prefix.includes(':')) return false;
  const segments = (prefix.endsWith('/') ? prefix.slice(0, -1) : prefix).split('/');
  if (segments.some((segment) => segment === '_local' || segment === '_design')) return false;
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function isSafeMarkdownPath(path: string): boolean {
  return path.toLowerCase().endsWith('.md') && isSafePrefix(path);
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === 'object'
    && (('status' in error && error.status === 404) || ('name' in error && error.name === 'not_found'));
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (utf8Bytes(value) <= maximumBytes) return value;
  let bytes = 0;
  let result = '';
  for (const character of value) {
    const size = utf8Bytes(character);
    if (bytes + size > maximumBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
