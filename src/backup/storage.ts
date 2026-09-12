import { TABLES, MAX_PART_BYTES, MAX_MANIFEST_BYTES, MAX_PARTS, counts, checkCounts, encodeCell, decodeCell, pack, unpack, hash, manifestFrom, backupId, fail, retentionIds } from './format.ts';
import type { Manifest, Table } from './format.ts';

export const prefix = (database: string) => `backups/${encodeURIComponent(database)}/`;
export const directory = (database: string, id: string) => `${prefix(database)}${backupId(id)}/`;
export async function readManifest(bucket: R2Bucket, database: string, id: string): Promise<Manifest> {
  const object = await bucket.get(`${directory(database, id)}manifest.json`);
  if (!object) fail('Completed backup not found', 404);
  if (object.size > MAX_MANIFEST_BYTES) fail('Manifest too large');
  const manifest = manifestFrom(await object.json());
  if (manifest.database !== database || manifest.id !== id) fail('Backup identity mismatch');
  return manifest;
}
export async function listBackups(bucket: R2Bucket, database: string): Promise<Manifest[]> {
  const result: Manifest[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: prefix(database), delimiter: '/', cursor });
    for (const path of page.delimitedPrefixes) {
      const id = path.slice(prefix(database).length, -1);
      const object = await bucket.head(`${path}manifest.json`);
      if (object) result.push(await readManifest(bucket, database, id));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function exportTables(sql: SqlStorage, bucket: R2Bucket, database: string, check: () => void): Promise<Manifest> {
  const start = Date.now();
  const m: Manifest = { format: 2, id: `${start}-${crypto.randomUUID()}`, database, createdAt: new Date(start).toISOString(),
    adapter: '1.1.2-cloudflare-do.1', application: '0.1.0', tables: counts(), parts: [], bytes: 0, pauseMs: 0 };
  let lines: string[] = [], rawBytes = 0;
  const flush = async () => {
    if (!lines.length) return;
    check();
    if (m.parts.length >= MAX_PARTS) fail('Backup exceeds part limit');
    const compressed = pack(lines);
    const part = { file: `${String(m.parts.length).padStart(6, '0')}.jsonl.gz`, rows: lines.length,
      bytes: compressed.byteLength, rawBytes, sha256: hash(compressed) };
    await bucket.put(`${directory(database, m.id)}${part.file}`, compressed);
    check();
    m.parts.push(part); m.bytes += part.bytes; lines = []; rawBytes = 0;
  };
  for (const table of Object.keys(TABLES) as Table[]) {
    // One row at a time avoids materialising the vault; source writes are gated by the caller.
    const cursor = sql.exec(`SELECT ${TABLES[table].map(c => `"${c}"`).join(',')} FROM "${table}"${table === 'sqlite_sequence' ? " WHERE name='by-sequence'" : ''} ORDER BY rowid`);
    for (const row of cursor) {
      check();
      const line = JSON.stringify({ table, values: TABLES[table].map(c => encodeCell(row[c])) }) + '\n';
      const size = Buffer.byteLength(line);
      if (size > MAX_PART_BYTES) fail('A database row exceeds the backup part limit');
      if (rawBytes + size > MAX_PART_BYTES) await flush();
      lines.push(line); rawBytes += size; m.tables[table]++;
    }
  }
  await flush(); check();
  m.pauseMs = Date.now() - start;
  return m;
}
export async function readPart(bucket: R2Bucket, m: Manifest, index: number) {
  const part = m.parts[index];
  const object = await bucket.get(`${directory(m.database, m.id)}${part.file}`);
  if (!object || object.size !== part.bytes) fail('Missing or invalid backup part');
  return unpack(new Uint8Array(await object.arrayBuffer()), part);
}
export async function verifyBackup(bucket: R2Bucket, m: Manifest): Promise<void> {
  const actual = counts();
  for (let i = 0; i < m.parts.length; i++) for (const row of await readPart(bucket, m, i)) actual[row.table]++;
  checkCounts(actual, m.tables);
  if (actual['metadata-store'] !== 1) fail('Backup requires exactly one metadata row');
}
export async function importTables(storage: DurableObjectStorage, bucket: R2Bucket, m: Manifest): Promise<void> {
  const sql = storage.sql;
  storage.transactionSync(() => {
    for (const t of Object.keys(TABLES)) sql.exec(`DELETE FROM "${t}"${t === 'sqlite_sequence' ? " WHERE name='by-sequence'" : ''}`);
  });
  const actual = counts();
  for (let i = 0; i < m.parts.length; i++) {
    const rows = await readPart(bucket, m, i);
    storage.transactionSync(() => {
      for (const row of rows) {
        const columns = TABLES[row.table];
        if (row.table === 'sqlite_sequence') sql.exec("DELETE FROM sqlite_sequence WHERE name='by-sequence'");
        sql.exec(`INSERT INTO "${row.table}" (${columns.map(c => `"${c}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
          ...row.values.map(v => { const cell = decodeCell(v); return cell instanceof Uint8Array ? cell.buffer : cell; }));
        actual[row.table]++;
      }
    });
  }
  checkCounts(actual, m.tables);
  for (const table of Object.keys(TABLES) as Table[]) {
    const count = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}"${table === 'sqlite_sequence' ? " WHERE name='by-sequence'" : ''}`).one().n;
    if (count !== m.tables[table]) fail('Restored table count mismatch');
  }
  // SQLite may have advanced its sequence while rows were inserted. The stored high-water mark must match.
  const bad = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM "document-store" d LEFT JOIN "by-sequence" b ON b.seq=d.winningseq WHERE b.seq IS NULL OR b.doc_id<>d.id`).one().n;
  if (bad) fail('Restored database integrity check failed');
  const sequence = sql.exec<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name='by-sequence'").toArray();
  const maximum = sql.exec<{ n: number }>('SELECT COALESCE(MAX(seq),0) AS n FROM "by-sequence"').one().n;
  if (sequence.length > 1 || (sequence[0]?.seq ?? 0) < maximum) fail('Invalid sequence high-water mark');
  const orphanAttachments = sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM "attach-seq-store" r LEFT JOIN "attach-store" a ON a.digest=r.digest LEFT JOIN "by-sequence" b ON b.seq=r.seq WHERE a.digest IS NULL OR b.seq IS NULL').one().n;
  if (orphanAttachments) fail('Invalid attachment references');
  const meta = sql.exec<{ db_version: number; doc_count: number }>('SELECT db_version, doc_count FROM "metadata-store"').toArray();
  if (meta.length !== 1) fail('Restore requires exactly one metadata row');
  if (meta[0].db_version !== 2) fail('Unsupported adapter schema: expected schema 2');
  if (!Number.isSafeInteger(meta[0].doc_count) || meta[0].doc_count < 0) fail('Invalid restored doc_count');
  // Independent oracle, run once while adapter handles are closed and the target is gated.
  const count = sql.exec<{ num: number }>(`SELECT COUNT(d.id) AS num
    FROM "document-store" d
    JOIN "by-sequence" b ON b.seq = d.winningseq
    WHERE b.deleted = 0`).one().num;
  if (count !== meta[0].doc_count) fail('Restored doc_count mismatch');
}
export async function prune(bucket: R2Bucket, database: string, policy: {daily: number; weekly: number; monthly: number}): Promise<void> {
  const backups = await listBackups(bucket, database);
  const keep = retentionIds(backups, policy);
  for (const m of backups) if (!keep.has(m.id)) {
    // Unpublish first: a partly deleted backup is never offered for restore.
    await bucket.delete(`${directory(database, m.id)}manifest.json`);
    for (const part of m.parts) await bucket.delete(`${directory(database, m.id)}${part.file}`);
  }
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: prefix(database), cursor });
    for (const object of page.objects) {
      if (object.uploaded.getTime() > Date.now() - 7 * 86400_000 || object.key.endsWith('/manifest.json')) continue;
      const dir = object.key.slice(0, object.key.lastIndexOf('/') + 1);
      if (!(await bucket.head(`${dir}manifest.json`))) await bucket.delete(object.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
