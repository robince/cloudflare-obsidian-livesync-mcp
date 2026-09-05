import { exportTables, importTables, verifyBackup, readManifest, directory, prune } from './backup/storage';
import { fail, DATABASE_NAME, TABLES } from './backup/format';
import type { GetVaultFileOutlineRequest, GetVaultFileOutlineData } from '@cloudflare-obsidian-livesync/contracts';
import { changesFeed, streamChanges, openRevisions, badRequest } from './changes-feed';
import { chunkReferences } from './chunk-references';
import { DurableObject } from 'cloudflare:workers';
import cloudflareDOAdapter from '@robince/pouchdb-adapter-cloudflare-do';
import PouchDB from 'pouchdb-core';
import type {
  AppendVaultFileRequest,
  CreateVaultFileRequest,
  DeleteVaultFileRequest,
  ListVaultAttachmentsData,
  ListVaultAttachmentsRequest,
  ListVaultFilesRequest,
  ListVaultFilesData,
  PatchVaultFileData,
  PatchVaultFileRequest,
  PatchVaultFrontmatterData,
  PatchVaultFrontmatterRequest,
  ReadVaultAttachmentData,
  ReadVaultAttachmentRequest,
  ReadVaultFileRequest,
  ReadVaultFileData,
  ReadVaultFrontmatterData,
  ReadVaultFrontmatterRequest,
  SearchVaultFilesData,
  SearchVaultFilesRequest,
  UpdateVaultFileRequest,
  VaultResult,
  VaultStatusData,
  WriteVaultFileData,
} from '@cloudflare-obsidian-livesync/contracts';

import { booleanParam, couchError, json, jsonParam, pouchError, readJson } from './http';
import { matchesSelector, validateSelector } from './selector';
import { createInProcessCouchFetch } from './livesync-vault/in-process-couch-fetch';
import {
  inspectVaultProfile,
  MILESTONE_DOCUMENT_ID,
  type VaultProfileInspection,
} from './livesync-vault/profile';
import type { DatabaseInfo, JsonObject } from './types';
import type { CommonlibFacade } from './livesync-vault/commonlib';
import { LiveSyncVault } from './livesync-vault/vault';
import { LiveSyncSearch } from './livesync-vault/search';

PouchDB.plugin(cloudflareDOAdapter);

// Durable Object SQLite rejects a string or BLOB at 2 MB. Leave room for
// PouchDB's revision metadata and JSON serialisation overhead.
const MAX_STORED_VALUE_BYTES = 1_800_000;
const MAX_ATTACHMENT_BYTES = 900_000;

type AnyDatabase = PouchDB.Database<JsonObject> & {
  bulkGet(options: JsonObject): Promise<JsonObject>;
  id(): Promise<string>;
  purge(id: string, rev: string): Promise<JsonObject>;
};

interface ChangesRequest {
  doc_ids?: string[];
  selector?: Record<string, unknown>;
}

interface FindRequest {
  selector?: Record<string, unknown>;
  fields?: string[];
  limit?: number;
  skip?: number;
  sort?: Array<string | Record<string, 'asc' | 'desc'>>;
}

export class PouchDatabase extends DurableObject<Env> {
  private backupJob = false;
  private backupActive = false;
  private restoreActive = false;
  private db?: AnyDatabase;
  private dbName?: string;
  private activeChangeLongpolls = 0;
  private activeSemanticWrites = 0;
  private maintenanceActive = false;
  private searchLifecycle = Promise.resolve();
  private mutationLifecycle = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS cloudflare_pouchdb_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    this.dbName = this.meta('db_name');
  }

  private meta(key: string): string | undefined {
    return this.ctx.storage.sql
      .exec<{ value: string }>('SELECT value FROM cloudflare_pouchdb_meta WHERE key=?', key)
      .toArray()[0]?.value;
  }

  private setMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO cloudflare_pouchdb_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      key,
      value
    );
  }

  private exists(): boolean {
    if (this.meta('restore_state')) return false;
    return this.meta('exists') === 'true';
  }

  private database(name?: string): AnyDatabase {
    if (name && this.dbName && name !== this.dbName) {
      throw Object.assign(new Error('database identity mismatch'), { status: 409, name: 'conflict' });
    }
    if (name && !this.dbName) {
      this.dbName = name;
      this.setMeta('db_name', name);
    }
    if (!this.dbName) {
      throw Object.assign(new Error('database name is required'), { status: 400, name: 'bad_request' });
    }
    if (!this.db) {
      this.db = new PouchDB<JsonObject>(this.dbName, {
        adapter: 'sqlite',
        sqliteImplementation: 'cloudflare-do',
        durableObjectStorage: this.ctx.storage,
      } as PouchDB.Configuration.DatabaseConfiguration) as AnyDatabase;
    }
    return this.db;
  }

  async backupStatus() {
    let state = JSON.parse(this.meta('backup_status') ?? '{}') as { lastAttempt?: string; lastSuccess?: string; error?: string; bytes?: number; id?: string; pendingId?: string };
    // Recover a publication that succeeded just before the process stopped.
    if (state.pendingId && !this.backupJob) {
      try {
        const manifest = await readManifest(this.env.BACKUP_BUCKET, this.dbName ?? this.env.BACKUP_DATABASE, state.pendingId);
        state = { lastAttempt: state.lastAttempt, lastSuccess: manifest.createdAt, bytes: manifest.bytes, id: manifest.id };
        this.setMeta('backup_status', JSON.stringify(state));
      } catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
    }
    return { ...state, running: this.backupJob, database: this.dbName ?? this.env.BACKUP_DATABASE,
      overdue: !state.lastSuccess || Date.now() - Date.parse(state.lastSuccess) > 26 * 3600_000 };
  }

  async createBackup(name: string, scheduled = false) {
    if (name !== this.env.BACKUP_DATABASE) fail('Only BACKUP_DATABASE can be backed up');
    if (!this.env.BACKUP_BUCKET) fail('Backup bucket is not configured', 503);
    if (this.backupActive || this.activeSemanticWrites || this.restoreActive) fail('Vault busy; retry backup later', 503);
    const previous = await this.backupStatus();
    if (scheduled && (new Date().getUTCHours() < 3 || previous.lastSuccess?.slice(0, 10) === new Date().toISOString().slice(0, 10))) return { skipped: true };
    const policy = { daily: Number(this.env.BACKUP_DAILY), weekly: Number(this.env.BACKUP_WEEKLY), monthly: Number(this.env.BACKUP_MONTHLY) };
    for (const n of Object.values(policy)) if (!Number.isSafeInteger(n) || n < 1 || n > 10000) fail('Invalid backup retention');
    if (this.backupJob || this.backupActive || this.activeSemanticWrites || this.restoreActive) fail('Vault busy; retry backup later', 503);
    this.backupJob = true;
    this.backupActive = true;
    const started = Date.now();
    const state = { ...previous, lastAttempt: new Date(started).toISOString(), error: undefined as string | undefined };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const check = () => { if (cancelled || Date.now() - started >= 60_000) fail('Backup exceeded 60-second write pause', 503); };
    try {
      this.setMeta('backup_status', JSON.stringify(state));
      const exported = (async () => {
        await this.mutationLifecycle;
        check(); this.requireExists(); await this.database(name).info(); check();
        return exportTables(this.ctx.storage.sql, this.env.BACKUP_BUCKET, name, check);
      })();
      const manifest = await Promise.race([exported, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { cancelled = true; reject(Object.assign(new Error('Backup exceeded 60-second write pause'), { status: 503 })); }, 60_000);
      })]);
      check();
      // All source rows are now immutable R2 parts. Publication and pruning need no write pause.
      this.backupActive = false;
      if (timer) clearTimeout(timer);
      manifest.pauseMs = Date.now() - started;
      state.pendingId = manifest.id;
      this.setMeta('backup_status', JSON.stringify(state));
      await this.env.BACKUP_BUCKET.put(`${directory(name, manifest.id)}manifest.json`, JSON.stringify(manifest));
      this.setMeta('backup_status', JSON.stringify({ lastAttempt: state.lastAttempt, lastSuccess: manifest.createdAt, bytes: manifest.bytes, id: manifest.id }));
      console.log(JSON.stringify({ message: 'backup completed', id: manifest.id, bytes: manifest.bytes, pauseMs: manifest.pauseMs }));
      try { await prune(this.env.BACKUP_BUCKET, name, policy); }
      catch { this.setMeta('backup_status', JSON.stringify({ lastAttempt: state.lastAttempt, lastSuccess: manifest.createdAt, bytes: manifest.bytes, id: manifest.id, error: 'Backup completed but retention cleanup failed' })); }
      return manifest;
    } catch (error) {
      this.setMeta('backup_status', JSON.stringify({ ...state, error: error instanceof Error ? error.message : 'Backup failed' }));
      console.error(JSON.stringify({ message: 'backup failed' }));
      throw error;
    } finally { cancelled = true; if (timer) clearTimeout(timer); this.backupActive = false; this.backupJob = false; }
  }

  async restoreBackup(target: string, source: string, id: string, restart = false) {
    if (!DATABASE_NAME.test(target) || target === source) fail('Restore requires a fresh database name');
    if (this.restoreActive || this.backupActive || this.activeSemanticWrites) fail('Target busy', 409);
    if (this.dbName && !this.meta('restore_state')) fail('Target database already exists', 409);
    if (this.dbName && this.dbName !== target) fail('Target identity mismatch', 409);
    if (this.meta('restore_state') && !restart) fail('Incomplete restore; explicitly restart it', 409);
    this.restoreActive = true;
    try {
      this.setMeta('restore_state', 'importing');
      await this.mutationLifecycle;
      const manifest = await readManifest(this.env.BACKUP_BUCKET, source, id);
      await verifyBackup(this.env.BACKUP_BUCKET, manifest);
      if (this.db) { await this.db.close(); this.db = undefined; }
      this.ctx.storage.transactionSync(() => {
        for (const table of Object.keys(TABLES)) if (table !== 'sqlite_sequence') this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS "${table}"`);
      });
      const db = this.database(target);
      await db.info();
      await db.close(); this.db = undefined;
      await importTables(this.ctx.storage, this.env.BACKUP_BUCKET, manifest);
      const restored = this.database(target);
      const milestoneId = MILESTONE_DOCUMENT_ID;
      let milestone: JsonObject;
      try { milestone = await restored.get(milestoneId); }
      catch (error) { if (!isMissingDocument(error)) throw error; fail('Backup has no LiveSync milestone'); }
      await restored.put({ ...milestone, locked: true, cleaned: false, accepted_nodes: [] });
      await restored.info();
      this.ctx.storage.transactionSync(() => {
        this.setMeta('exists', 'true');
        this.ctx.storage.sql.exec("DELETE FROM cloudflare_pouchdb_meta WHERE key='restore_state'");
      });
      return { ok: true, database: target, backup: id, requiresLiveSyncReset: true };
    } catch (error) { this.setMeta('restore_state', 'failed'); throw error; }
    finally { this.restoreActive = false; }
  }

  async ensureDatabase(name: string): Promise<void> {
    await this.withMutation(async () => { if (this.meta('restore_state')) fail('Restore target unavailable', 503); this.database(name); this.setMeta('exists', 'true'); });
  }

  async getDocument(name: string, id: string, options: PouchDB.Core.GetOptions = {}): Promise<JsonObject> {
    this.requireExists();
    return (await this.database(name).get(id, options)) as JsonObject;
  }

  async putDocument(name: string, document: JsonObject): Promise<PouchDB.Core.Response> {
    this.requireExists();
    ensureDocumentSize(document);
    return this.withMutation(async () => { this.requireExists(); return this.database(name).put(document); });
  }

  async allDocuments(
    name: string,
    options: PouchDB.Core.AllDocsOptions = {}
  ): Promise<PouchDB.Core.AllDocsResponse<JsonObject>> {
    this.requireExists();
    return this.database(name).allDocs(options);
  }

  /**
   * The public semantic RPC deliberately has no database parameter. This
   * Durable Object owns exactly one persisted database identity.
   */
  async vaultStatus(): Promise<VaultResult<VaultStatusData>> {
    return this.vault().status();
  }

  async listVaultFiles(request: ListVaultFilesRequest): Promise<VaultResult<ListVaultFilesData>> {
    return this.vault().list(request);
  }

  async searchVaultFiles(request: SearchVaultFilesRequest): Promise<VaultResult<SearchVaultFilesData>> {
    return this.withSearchLifecycle(() => this.search().search(request));
  }

  async listVaultAttachments(request: ListVaultAttachmentsRequest): Promise<VaultResult<ListVaultAttachmentsData>> {
    return this.vault().listAttachments(request);
  }

  async readVaultFile(request: ReadVaultFileRequest): Promise<VaultResult<ReadVaultFileData>> {
    return this.vault().read(request);
  }

  async getVaultFileOutline(request: GetVaultFileOutlineRequest): Promise<VaultResult<GetVaultFileOutlineData>> {
    return this.vault().outline(request);
  }

  async readVaultAttachment(request: ReadVaultAttachmentRequest): Promise<VaultResult<ReadVaultAttachmentData>> {
    return this.vault().readAttachment(request);
  }

  async readVaultFrontmatter(request: ReadVaultFrontmatterRequest): Promise<VaultResult<ReadVaultFrontmatterData>> {
    return this.vault().readFrontmatter(request);
  }

  async createVaultFile(request: CreateVaultFileRequest): Promise<VaultResult<WriteVaultFileData>> {
    return this.withSemanticWrite(() => this.vault().create(request));
  }

  async updateVaultFile(request: UpdateVaultFileRequest): Promise<VaultResult<WriteVaultFileData>> {
    return this.withSemanticWrite(() => this.vault().update(request));
  }

  async appendVaultFile(request: AppendVaultFileRequest): Promise<VaultResult<WriteVaultFileData>> {
    return this.withSemanticWrite(() => this.vault().append(request));
  }

  async patchVaultFile(request: PatchVaultFileRequest): Promise<VaultResult<PatchVaultFileData>> {
    return this.withSemanticWrite(() => this.vault().patch(request));
  }

  async patchVaultFrontmatter(request: PatchVaultFrontmatterRequest): Promise<VaultResult<PatchVaultFrontmatterData>> {
    return this.withSemanticWrite(() => this.vault().patchFrontmatter(request));
  }

  async deleteVaultFile(request: DeleteVaultFileRequest): Promise<VaultResult<WriteVaultFileData>> {
    return this.withSemanticWrite(() => this.vault().delete(request));
  }

  private requireExists(): void {
    if (!this.exists()) {
      throw Object.assign(new Error('Database does not exist.'), { status: 404, name: 'not_found' });
    }
  }

  private vault(): LiveSyncVault {
    return new LiveSyncVault({
      profile: async () => {
        this.requireExists();
        return this.inspectCommonlibProfile();
      },
      acquireCommonlib: (profile) => this.createCommonlib(profile),
    });
  }

  private search(): LiveSyncSearch {
    return new LiveSyncSearch({
      storage: this.ctx.storage,
      database: () => {
        this.requireExists();
        return this.database();
      },
      profile: async () => {
        this.requireExists();
        return this.inspectCommonlibProfile();
      },
      acquireCommonlib: (profile) => this.createCommonlib(profile),
    });
  }

  private async withSemanticWrite<T>(operation: () => Promise<VaultResult<T>>): Promise<VaultResult<T>> {
    if (this.backupActive || this.meta('restore_state')) return { ok: false, error: { code: 'unavailable', message: 'Vault backup or restore maintenance is in progress. Retry later.' } };
    if (this.maintenanceActive) return { ok: false, error: { code: 'unavailable', message: 'Vault maintenance is in progress. Retry after maintenance completes.' } };
    this.activeSemanticWrites++;
    try { return await operation(); } finally { this.activeSemanticWrites--; }
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.backupActive || this.meta('restore_state')) fail('Vault maintenance; retry later', 503);
    const previous = this.mutationLifecycle;
    let release!: () => void;
    this.mutationLifecycle = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.backupActive || this.meta('restore_state')) fail('Vault maintenance; retry later', 503);
      return await operation();
    } finally { release(); }
  }

  private async withSearchLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    // ponytail: one per-vault queue is enough; split it only if concurrent search/purge throughput matters.
    const previous = this.searchLifecycle;
    let release!: () => void;
    this.searchLifecycle = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async createCommonlib(profile: VaultProfileInspection): Promise<CommonlibFacade> {
    this.requireExists();
    if (!this.dbName) throw new Error('database identity is required');
    const { CommonlibFacade } = await import('./livesync-vault/commonlib');
    return new CommonlibFacade(
      this.dbName,
      this.inProcessCouchFetch(),
      profile
    );
  }

  private async inspectCommonlibProfile(): Promise<VaultProfileInspection> {
    const db = this.database();
    const getOptional = async (id: string): Promise<JsonObject | undefined> => {
      try {
        return await db.get(id) as JsonObject;
      } catch (error) {
        if (isMissingDocument(error)) return undefined;
        throw error;
      }
    };
    return inspectVaultProfile(await getOptional(MILESTONE_DOCUMENT_ID));
  }

  private inProcessCouchFetch(): typeof globalThis.fetch {
    if (!this.dbName) throw new Error('database identity is required');
    const databaseName = this.dbName;
    return createInProcessCouchFetch(databaseName, async (request) => await this.fetch(request));
  }

  async fetch(request: Request): Promise<Response> {
    const name = request.headers.get('x-pouchdb-database');
    if (!name) return couchError(400, 'bad_request', 'database name is required');
    try {
      if (this.meta('restore_state')) fail('Restore target unavailable', 503);
      const parts = new URL(request.url).pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const first = parts[0];
      const readPost = ['_changes', '_all_docs', '_bulk_get', '_revs_diff', '_find', '_index', '_ensure_full_commit'].includes(first ?? '');
      const mutate = !['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !(request.method === 'POST' && readPost);
      if (first === '_purge' || (!first && request.method === 'DELETE')) {
        return await this.withSearchLifecycle(() => this.withMutation(() => this.route(request, name, parts)));
      }
      return mutate ? await this.withMutation(() => this.route(request, name, parts)) : await this.route(request, name, parts);
    } catch (error) {
      return pouchError(error);
    }
  }

  private async route(request: Request, name: string, parts: string[]): Promise<Response> {
    const url = new URL(request.url);

    if (parts.length === 0) return this.databaseRoute(request, name);
    this.requireExists();
    const db = this.database(name);
    const first = parts[0];

    if (first === '_all_docs') return this.allDocsRoute(request, url, db);
    if (first === '_bulk_docs') return this.bulkDocsRoute(request, db);
    if (first === '_bulk_get') return this.bulkGetRoute(request, url, db);
    if (first === '_revs_diff') return this.revsDiffRoute(request, db);
    if (first === '_changes') return this.changesRoute(request, url, db);
    if (first === '_find') return this.findRoute(request, db);
    if (first === '_index') return this.indexRoute(request);
    if (first === '_compact') return this.compactRoute(request, db);
    if (first === '_ensure_full_commit') return json({ ok: true, instance_start_time: '0' });
    if (first === '_purge') return this.purgeRoute(request, db);
    if (parts[0] === '_design' && parts[2] === '_view') return this.viewRoute(request, parts, db);

    return this.documentRoute(request, url, parts, db);
  }

  private async databaseRoute(request: Request, name: string): Promise<Response> {
    if (request.method === 'PUT') {
      if (this.exists()) return couchError(412, 'file_exists', 'The database could not be created.');
      this.database(name);
      this.setMeta('exists', 'true');
      return json({ ok: true }, { status: 201 });
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (!this.exists()) return couchError(404, 'not_found', 'Database does not exist.');
      const info = await this.database(name).info();
      const size = this.ctx.storage.sql.databaseSize;
      const body: DatabaseInfo = {
        db_name: name,
        doc_count: info.doc_count,
        doc_del_count: 0,
        update_seq: info.update_seq,
        purge_seq: 0,
        compact_running: false,
        disk_format_version: 6,
        instance_start_time: '0',
        sizes: { file: size, external: size, active: size },
      };
      return request.method === 'HEAD' ? new Response(null, { status: 200 }) : json(body);
    }
    if (request.method === 'POST') {
      this.requireExists();
      const document = await readJson<JsonObject>(request);
      ensureDocumentSize(document);
      return json(await this.database(name).post(document), { status: 201 });
    }
    if (request.method === 'DELETE') {
      if (!this.exists()) return couchError(404, 'not_found', 'Database does not exist.');
      await this.database(name).destroy();
      this.db = undefined;
      this.setMeta('exists', 'false');
      return json({ ok: true });
    }
    return couchError(405, 'method_not_allowed', 'Only GET, HEAD, PUT, POST, and DELETE are supported.');
  }

  private async bulkDocsRoute(request: Request, db: AnyDatabase): Promise<Response> {
    if (request.method !== 'POST') return couchError(405, 'method_not_allowed', 'POST required');
    const body = await readJson<{ docs: JsonObject[]; new_edits?: boolean }>(request);
    for (const document of body.docs) ensureDocumentSize(document);
    const result = await db.bulkDocs(body.docs, { new_edits: body.new_edits !== false });
    return json(result, { status: 201 });
  }

  private async allDocsRoute(request: Request, url: URL, db: AnyDatabase): Promise<Response> {
    const body = request.method === 'POST' ? await readJson<{ keys?: string[] }>(request) : {};
    const options = {
      keys: body.keys,
      key: jsonParam(url, 'key'),
      startkey: jsonParam(url, 'startkey'),
      endkey: jsonParam(url, 'endkey'),
      include_docs: booleanParam(url, 'include_docs'),
      attachments: booleanParam(url, 'attachments'),
      conflicts: booleanParam(url, 'conflicts'),
      descending: booleanParam(url, 'descending'),
      inclusive_end: booleanParam(url, 'inclusive_end'),
      update_seq: booleanParam(url, 'update_seq'),
      limit: numberParam(url, 'limit'),
      skip: numberParam(url, 'skip'),
    };
    return json(await db.allDocs(compactUndefined(options) as PouchDB.Core.AllDocsWithKeysOptions));
  }

  private async bulkGetRoute(request: Request, url: URL, db: AnyDatabase): Promise<Response> {
    const body = await readJson<{ docs: Array<{ id: string; rev?: string }> }>(request);
    return json(
      await db.bulkGet({
        docs: body.docs,
        revs: booleanParam(url, 'revs'),
        attachments: booleanParam(url, 'attachments'),
        latest: booleanParam(url, 'latest'),
      })
    );
  }

  private async revsDiffRoute(request: Request, db: AnyDatabase): Promise<Response> {
    const revisions = await readJson<Record<string, string[]>>(request);
    return json(await db.revsDiff(revisions));
  }

  private async changesRoute(request: Request, url: URL, db: AnyDatabase): Promise<Response> {
    const body = request.method === 'POST' ? await readJson<ChangesRequest>(request) : {};
    const value = url.searchParams.get('since') ?? '0';
    if (value !== 'now' && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) throw badRequest('Invalid since sequence');
    const since = value === 'now' ? Number((await db.info()).update_seq) : Number(value);
    let iterator = changesFeed(db, this.ctx.storage.sql, url, body, since, request.signal);
    let first = await iterator.next();
    if (url.searchParams.get('feed') === 'longpoll' && first.done) {
      const resume = first.value.last_seq;
      this.activeChangeLongpolls++;
      try { await waitForChange(db, resume, Math.min(numberParam(url, 'timeout') ?? 25_000, 55_000), request.signal); }
      finally { this.activeChangeLongpolls--; }
      iterator = changesFeed(db, this.ctx.storage.sql, url, body, resume, request.signal);
      first = await iterator.next();
    }
    return streamChanges(iterator, first, url.searchParams.get('feed') === 'continuous');
  }

  private async findRoute(request: Request, db: AnyDatabase): Promise<Response> {
    const body = await readJson<FindRequest>(request);
    validateSelector(body.selector ?? {});
    const all = await db.allDocs({ include_docs: true });
    let docs = all.rows
      .map((row) => row.doc as JsonObject | undefined)
      .filter((doc): doc is JsonObject => !!doc && !String(doc._id).startsWith('_design/'))
      .filter((doc) => matchesSelector(doc, body.selector ?? {}));
    docs = sortDocuments(docs, body.sort);
    docs = docs.slice(body.skip ?? 0, body.limit === undefined ? undefined : (body.skip ?? 0) + body.limit);
    if (body.fields) docs = docs.map((doc) => Object.fromEntries(body.fields!.map((key) => [key, doc[key]])));
    return json({ docs, bookmark: 'nil' });
  }

  private async indexRoute(request: Request): Promise<Response> {
    if (request.method === 'GET') {
      return json({ total_rows: 1, indexes: [{ ddoc: null, name: '_all_docs', type: 'special', def: { fields: [{ _id: 'asc' }] } }] });
    }
    if (request.method === 'POST') return json({ result: 'created', id: '_design/cloudflare', name: 'cloudflare' });
    return couchError(405, 'method_not_allowed', 'GET or POST required');
  }

  private async compactRoute(request: Request, db: AnyDatabase): Promise<Response> {
    if (request.method !== 'POST') return couchError(405, 'method_not_allowed', 'POST required');
    await db.compact();
    return json({ ok: true }, { status: 202 });
  }

  private async purgeRoute(request: Request, db: AnyDatabase): Promise<Response> {
    if (request.method !== 'POST') return couchError(405, 'method_not_allowed', 'POST required');
    const requested = await readJson<Record<string, string[]>>(request);
    if (!requested || typeof requested !== 'object' || Array.isArray(requested)
      || Object.entries(requested).length > 100 || Object.values(requested).some((revs) => !Array.isArray(revs) || revs.length > 100 || !revs.every((rev) => typeof rev === 'string'))) throw badRequest('Invalid purge batch');
    if (this.activeSemanticWrites > 0) return couchError(409, 'maintenance_busy', 'An MCP write is in progress. Complete replication and pause writers before retrying cleanup.');
    this.maintenanceActive = true;
    try {
    if (Object.keys(requested).some((id) => id.startsWith('h:'))) {
      const references = await chunkReferences(db, this.ctx.storage.sql);
      if (Object.keys(requested).some((id) => id.startsWith('h:') && (references.get(id) ?? 0) > 0)) {
        return couchError(409, 'chunk_referenced', 'Requested chunks are still referenced by retained revisions. No chunks were purged.');
      }
    }
    {
      // Purge has no _changes entry. Invalidate first so a partial purge failure
      // can only cause harmless replay, never a permanently stale search row.
      this.search().invalidatePurgedDocuments(Object.keys(requested));
      const purged: Record<string, string[]> = {};
      for (const [id, revisions] of Object.entries(requested)) {
        for (const revision of revisions) await db.purge(id, revision);
        purged[id] = revisions;
      }
      return json({ purge_seq: null, purged });
    }
    } finally { this.maintenanceActive = false; }
  }

  private async viewRoute(request: Request, parts: string[], db: AnyDatabase): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'POST') {
      return couchError(405, 'method_not_allowed', 'GET or POST required');
    }
    if (parts[1] !== 'chunks' || parts[3] !== 'collectDangling') {
      return couchError(404, 'not_found', 'missing_named_view');
    }
    const totals = await chunkReferences(db, this.ctx.storage.sql);
    return json({ total_rows: totals.size, offset: 0, rows: [...totals].sort().map(([id, value]) => ({ id, key: [id], value })) });
  }

  private async documentRoute(request: Request, url: URL, parts: string[], db: AnyDatabase): Promise<Response> {
    const special = parts[0] === '_design' || parts[0] === '_local';
    const id = special ? `${parts[0]}/${parts[1]}` : parts[0];
    const attachment = parts.slice(special ? 2 : 1).join('/');
    if (attachment) return this.attachmentRoute(request, url, db, id, attachment);

    if (request.method === 'GET') {
      const options = compactUndefined({
        rev: url.searchParams.get('rev') ?? undefined,
        revs: booleanParam(url, 'revs'),
        revs_info: booleanParam(url, 'revs_info'),
        latest: booleanParam(url, 'latest'),
        conflicts: booleanParam(url, 'conflicts'),
        attachments: booleanParam(url, 'attachments'),
        binary: false,
        open_revs: openRevisions(url),
      });
      if (options.open_revs) return json(await db.get(id, options as PouchDB.Core.GetOptions));
      return json(await db.get(id, options));
    }
    if (request.method === 'PUT') {
      const doc = await readJson<JsonObject>(request);
      doc._id = id;
      ensureDocumentSize(doc);
      return json(await db.put(doc), { status: 201 });
    }
    if (request.method === 'DELETE') {
      const rev = url.searchParams.get('rev');
      if (!rev) return couchError(400, 'bad_request', 'Document revision is required.');
      return json(await db.remove(id, rev));
    }
    return couchError(405, 'method_not_allowed', 'GET, PUT, or DELETE required');
  }

  private async attachmentRoute(request: Request, url: URL, db: AnyDatabase, id: string, attachment: string): Promise<Response> {
    const rev = url.searchParams.get('rev') ?? undefined;
    if (request.method === 'GET') {
      const doc = await db.get(id);
      const metadata = (doc._attachments as Record<string, { content_type?: string }> | undefined)?.[attachment];
      const data = await db.getAttachment(id, attachment, { rev });
      return new Response(data as BodyInit, { headers: { 'content-type': metadata?.content_type ?? 'application/octet-stream' } });
    }
    if (request.method === 'PUT') {
      // workerd exposes Blob but not FileReader. Passing a Blob to PouchDB's
      // browser binary helper therefore fails; its base64 input path is fully
      // portable and is also the CouchDB wire representation.
      const buffer = await request.arrayBuffer();
      if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
        return couchError(413, 'too_large', 'Attachment exceeds the Durable Object SQLite value limit.');
      }
      const data = arrayBufferToBase64(buffer);
      const type = request.headers.get('content-type') ?? 'application/octet-stream';
      const result = rev
        ? await db.putAttachment(id, attachment, rev, data as unknown as Blob, type)
        : await db.putAttachment(id, attachment, data as unknown as Blob, type);
      return json(result, { status: 201 });
    }
    if (request.method === 'DELETE' && rev) return json(await db.removeAttachment(id, attachment, rev));
    return couchError(400, 'bad_request', 'Attachment revision is required.');
  }
}

function numberParam(url: URL, key: string): number | undefined {
  const value = url.searchParams.get(key);
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compactUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 32_768;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function ensureDocumentSize(document: JsonObject): void {
  const bytes = new TextEncoder().encode(JSON.stringify(document)).byteLength;
  if (bytes > MAX_STORED_VALUE_BYTES) {
    throw Object.assign(
      new Error('Document exceeds the Durable Object SQLite value limit.'),
      { status: 413, name: 'too_large' }
    );
  }
  const attachments = document._attachments;
  if (typeof attachments === 'object' && attachments !== null) {
    for (const attachment of Object.values(attachments as Record<string, unknown>)) {
      if (typeof attachment !== 'object' || attachment === null) continue;
      const data = (attachment as { data?: unknown }).data;
      if (typeof data === 'string' && Math.floor(data.length * 3 / 4) > MAX_ATTACHMENT_BYTES) {
        throw Object.assign(
          new Error('Attachment exceeds the Durable Object SQLite value limit.'),
          { status: 413, name: 'too_large' }
        );
      }
    }
  }
}

function isMissingDocument(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'status' in error && error.status === 404;
}

async function waitForChange(
  db: AnyDatabase,
  since: string | number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const feed = db.changes({ since, live: true, return_docs: false });
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      feed.cancel();
      error === undefined ? resolve() : reject(error);
    };
    const abort = () => finish(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => finish(), timeoutMs);
    feed.once('change', () => finish());
    feed.once('error', (error: unknown) => finish(error));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function sortDocuments(docs: JsonObject[], sort: FindRequest['sort']): JsonObject[] {
  if (!sort?.length) return docs;
  return [...docs].sort((left, right) => {
    for (const entry of sort) {
      const [field, direction] = typeof entry === 'string' ? [entry, 'asc'] : Object.entries(entry)[0];
      if (left[field] === right[field]) continue;
      const result = (left[field] as never) < (right[field] as never) ? -1 : 1;
      return direction === 'desc' ? -result : result;
    }
    return 0;
  });
}
