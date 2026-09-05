import { readFrontmatter } from './frontmatter';
import { normalizeProperties, propertyPredicate } from './property-query';
import { frontmatterFilterSchema } from '@cloudflare-obsidian-livesync/contracts';
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

const SEARCH_SCHEMA_VERSION = '3';
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
  frontmatter: string;
};

type CatchUpResult = 'ready' | 'catching_up' | { pendingPath: string };

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
        if (typeof catchUp === 'object') {
          return failure('unavailable', `Search is waiting for referenced LiveSync chunks for ${catchUp.pendingPath}. Complete replication or repair this note in Obsidian before retrying.`);
        }
        if (catchUp === 'catching_up') {
          return failure('unavailable', 'Search index is catching up with LiveSync changes. Retry search_files.');
        }
        return {
          ok: true,
          data: await this.query(parsed.data, profile.handleFilenameCaseSensitive),
        };
      } finally {
        if (commonlib) await commonlib.close();
      }
    } catch (error) {
      if (error instanceof SearchInputError) return failure(error.code, error.message);
      console.error(JSON.stringify({ message: 'search_files failed', error: errorMessage(error) }));
      return failure('internal', 'Search is temporarily unavailable.');
    }
  }

  invalidatePurgedDocuments(documentIds: string[]): void {
    if (!this.hasSchema()) return;
    this.dependencies.storage.transactionSync(() => {
      for (const documentId of documentIds) this.deleteDocument(documentId);
      this.setState('checkpoint', '0');
      this.bumpGeneration();
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
      exclusion_reason TEXT,
      frontmatter TEXT NOT NULL DEFAULT '{}',
      dates TEXT NOT NULL DEFAULT '{}',
      properties_valid INTEGER NOT NULL DEFAULT 1
    )`);
    sql.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS livesync_search_fts USING fts5(
      path,
      title,
      content,
      tokenize='unicode61 remove_diacritics 2'
    )`);
    this.setState('schema_version', SEARCH_SCHEMA_VERSION);
    if (!this.state('generation')) this.bumpGeneration();
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
      this.bumpGeneration();
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
            if (existing.unresolved_versions !== unresolvedVersions) this.bumpGeneration();
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
        if (file.kind === 'pending') return { pendingPath: path };
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

  private async query(request: SearchVaultFilesRequest, caseSensitive: boolean): Promise<SearchVaultFilesData> {
    const limit = request.limit ?? VAULT_LIMITS.defaultSearchLimit;
    const query = request.query?.trim();
    const pathPrefix = request.pathPrefix ?? '';
    const fingerprintBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({
      query, pathPrefix, filters: request.filters ?? [], properties: request.properties ?? [], caseSensitive,
    })));
    const fingerprint = Array.from(new Uint8Array(fingerprintBytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const generation = this.state('generation')!;
    const database = this.state('database_id')!;
    let offset = 0;
    if (request.cursor) {
      let cursor: { v: number; generation: string; database: string; fingerprint: string; offset: number };
      try {
        cursor = JSON.parse(atob(request.cursor));
        if (!cursor || cursor.v !== 1 || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0
          || typeof cursor.generation !== 'string' || typeof cursor.database !== 'string'
          || cursor.fingerprint !== fingerprint) throw new Error();
      } catch { throw new SearchInputError('invalid_input', 'Invalid cursor or changed query. Restart search_files without a cursor.'); }
      if (cursor.generation !== generation || cursor.database !== database) {
        throw new SearchInputError('cursor_expired', 'Search results changed. Restart search_files without a cursor.');
      }
      offset = cursor.offset;
    }
    const predicates: string[] = ["d.status='indexed'"];
    const bindings: (string | number | null)[] = [];
    if (query) {
      predicates.push('livesync_search_fts MATCH ?');
      bindings.push(query.split(/\s+/u).map((term) => `"${term.replaceAll('"', '""')}"`).join(' '));
    }
    if (pathPrefix) {
      predicates.push(`instr(d.${caseSensitive ? 'path' : 'path_folded'}, ?)=1`);
      bindings.push(caseSensitive ? pathPrefix : pathPrefix.toLowerCase());
    }
    const propertyQuery = !!request.filters?.length || !!request.properties?.length;
    if (propertyQuery) predicates.push('d.properties_valid=1');
    for (const filter of request.filters ?? []) {
      const predicate = propertyPredicate(filter);
      predicates.push(predicate.sql);
      bindings.push(...predicate.bindings);
    }
    const rows = this.dependencies.storage.sql.exec<SearchRow>(
      `SELECT d.path,d.revision,d.unresolved_versions,d.frontmatter,
       ${query ? "snippet(livesync_search_fts,-1,'⟦','⟧','…',24)" : "''"} AS snippet
       FROM livesync_search_documents d
       ${query ? 'JOIN livesync_search_fts ON livesync_search_fts.rowid=d.fts_rowid' : ''}
       WHERE ${predicates.join(' AND ')}
       ORDER BY ${query ? 'bm25(livesync_search_fts,4.0,8.0,1.0),' : ''}d.path ASC LIMIT ? OFFSET ?`,
      ...bindings, limit + 1, offset,
    ).toArray();
    const counts = this.dependencies.storage.sql.exec<{ excluded: number; invalid: number }>(
      "SELECT COALESCE(SUM(status='excluded'),0) AS excluded, COALESCE(SUM(status='indexed' AND properties_valid=0),0) AS invalid FROM livesync_search_documents",
    ).one();
    const results: SearchVaultFilesData['results'] = [];
    const makeResponse = (more: boolean): SearchVaultFilesData => ({
      results, truncated: more, incomplete: counts.excluded > 0 || (propertyQuery && counts.invalid > 0),
      unindexedFiles: counts.excluded,
      ...(propertyQuery ? { unqueryableFiles: counts.invalid } : {}),
      ...(more ? { cursor: btoa(JSON.stringify({ v: 1, generation, database, fingerprint, offset: offset + results.length })) } : {}),
    });
    for (const row of rows.slice(0, limit)) {
      const allProperties = JSON.parse(row.frontmatter) as Record<string, {} | null>;
      results.push({ path: row.path, revision: row.revision,
        snippet: truncateUtf8(row.snippet, VAULT_LIMITS.maxSearchSnippetBytes),
        ...(row.unresolved_versions > 1 ? { unresolvedVersions: row.unresolved_versions } : {}),
        ...(request.properties ? { properties: Object.fromEntries(request.properties.filter((key) => Object.hasOwn(allProperties, key)).map((key) => [key, allProperties[key]])) } : {}),
      });
      const response = makeResponse(true);
      // Include structured content and its serialized-text fallback in the budget.
      if (utf8Bytes(JSON.stringify({ structuredContent: response, content: [{ type: 'text', text: JSON.stringify(response) }] })) > VAULT_LIMITS.maxSearchResponseBytes) {
        results.pop();
        if (!results.length) throw new SearchInputError('too_large', 'Selected properties exceed the response budget. Request fewer properties and read_frontmatter separately.');
        return makeResponse(true);
      }
    }
    return makeResponse(rows.length > results.length);
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
      let properties: Record<string, unknown> = {};
      let valid = 1;
      try { properties = normalizeProperties(readFrontmatter(content)); } catch { valid = 0; }
      const dates = Object.fromEntries(Object.entries(properties).filter(([property, value]) =>
        frontmatterFilterSchema.safeParse({ property, value, operator: 'lt', type: 'date' }).success,
      ).map(([key, value]) => [key, Date.parse(value as string)]));
      this.dependencies.storage.sql.exec('UPDATE livesync_search_documents SET frontmatter=?,dates=?,properties_valid=? WHERE doc_id=?',
        JSON.stringify(properties), JSON.stringify(dates), valid, documentId);
      this.bumpGeneration();
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
      this.bumpGeneration();
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
    if (row) this.bumpGeneration();
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

  private bumpGeneration(): void { this.setState('generation', crypto.randomUUID()); }

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

class SearchInputError extends Error {
  constructor(readonly code: 'invalid_input' | 'cursor_expired' | 'too_large', message: string) { super(message); }
}

function failure(code: 'invalid_input' | 'cursor_expired' | 'too_large' | 'unsupported' | 'unavailable' | 'internal', message: string): VaultResult<never> {
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
