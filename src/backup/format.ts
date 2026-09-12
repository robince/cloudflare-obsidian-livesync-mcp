import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

// Versioned against the pinned SQLite adapter. Never execute schema from an archive.
export const TABLES = {
  'metadata-store': ['dbid', 'db_version', 'doc_count'],
  'document-store': ['id', 'json', 'winningseq', 'max_seq'],
  'by-sequence': ['seq', 'json', 'deleted', 'doc_id', 'rev'],
  'attach-store': ['digest', 'escaped', 'body'],
  'attach-seq-store': ['digest', 'seq'],
  'local-store': ['id', 'rev', 'json'],
  'sqlite_sequence': ['name', 'seq'],
} as const;
export type Table = keyof typeof TABLES;
export type Cell = string | number | null | { base64: string };
export type RecordRow = { table: Table; values: Cell[] };
export const MAX_PART_BYTES = 4 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const MAX_PARTS = 4096;
export const DATABASE_NAME = /^[a-z][a-z0-9_$()+-]*$/;
export type Part = { file: string; bytes: number; rawBytes: number; rows: number; sha256: string };
export type Manifest = {
  format: 2; id: string; database: string; createdAt: string;
  adapter: '1.1.2-cloudflare-do.1'; application: '0.1.0';
  tables: Record<Table, number>; parts: Part[]; bytes: number; pauseMs: number;
};
export function fail(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status, name: 'backup_error' });
}
export function backupId(id: string): string {
  if (!/^\d{13}-[a-f0-9-]{36}$/.test(id)) fail('Invalid backup ID');
  return id;
}
export function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
export function encodeCell(value: unknown): Cell {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return { base64: Buffer.from(bytes).toString('base64') };
  }
  if (value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return value;
  return fail('Unsupported SQL cell');
}
export function decodeCell(value: Cell): string | number | null | Uint8Array {
  if (value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (value && typeof value === 'object' && Object.keys(value).length === 1 && typeof value.base64 === 'string') {
    const bytes = Buffer.from(value.base64, 'base64');
    if (bytes.toString('base64') === value.base64) return new Uint8Array(bytes);
  }
  return fail('Invalid SQL cell');
}
export function pack(lines: string[]): Uint8Array { return new Uint8Array(gzipSync(lines.join(''), { level: 6 })); }
export function unpack(bytes: Uint8Array, part: Part): RecordRow[] {
  if (bytes.byteLength !== part.bytes || hash(bytes) !== part.sha256) fail('Backup part checksum mismatch');
  const raw = gunzipSync(bytes, { maxOutputLength: MAX_PART_BYTES });
  if (raw.byteLength !== part.rawBytes) fail('Backup part size mismatch');
  const lines = raw.toString('utf8').split('\n');
  if (lines.pop() !== '') fail('Incomplete backup part');
  if (lines.length !== part.rows) fail('Backup row count mismatch');
  return lines.map(line => {
    const row = JSON.parse(line) as RecordRow;
    if (!row || !Object.hasOwn(TABLES, row.table) || !Array.isArray(row.values)
      || row.values.length !== TABLES[row.table].length) fail('Invalid backup table/row');
    row.values.forEach(decodeCell);
    if (row.table === 'metadata-store') {
      if (row.values[1] !== 2) fail('Unsupported adapter schema: expected schema 2');
      const count = row.values[2];
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) fail('Invalid restored doc_count');
    }
    if (row.table === 'sqlite_sequence' && row.values[0] !== 'by-sequence') fail('Invalid sequence table');
    return row;
  });
}
export function manifestFrom(value: unknown): Manifest {
  if (value && typeof value === 'object' && 'format' in value && value.format === 1) {
    fail('Format-1 backups are unsupported. Use the old application and its compatible backup in an isolated schema-1 deployment; see docs/backup-recovery.md.');
  }
  const m = value as Manifest;
  if (!m || m.format !== 2 || m.adapter !== '1.1.2-cloudflare-do.1' || m.application !== '0.1.0'
    || typeof m.id !== 'string' || typeof m.database !== 'string' || !DATABASE_NAME.test(m.database)
    || typeof m.createdAt !== 'string' || !Number.isFinite(Date.parse(m.createdAt))
    || !Number.isSafeInteger(m.bytes) || m.bytes < 0 || !Number.isFinite(m.pauseMs) || m.pauseMs < 0
    || !m.tables || Object.keys(m.tables).length !== Object.keys(TABLES).length
    || !Array.isArray(m.parts) || m.parts.length > MAX_PARTS) fail('Unsupported or invalid backup manifest');
  backupId(m.id);
  if (new Date(m.createdAt).toISOString() !== m.createdAt) fail('Invalid backup timestamp');
  for (const table of Object.keys(TABLES) as Table[]) if (!Number.isSafeInteger(m.tables[table]) || m.tables[table] < 0) fail('Invalid table counts');
  m.parts.forEach((p, i) => {
    if (p.file !== `${String(i).padStart(6, '0')}.jsonl.gz` || !Number.isSafeInteger(p.bytes) || p.bytes < 1 || p.bytes > MAX_PART_BYTES + 65536
      || !Number.isSafeInteger(p.rawBytes) || p.rawBytes < 1 || p.rawBytes > MAX_PART_BYTES
      || !Number.isSafeInteger(p.rows) || p.rows < 1 || !/^[a-f0-9]{64}$/.test(p.sha256)) fail('Invalid backup part');
  });
  if (m.parts.reduce((n, p) => n + p.bytes, 0) !== m.bytes) fail('Invalid total bytes');
  return m;
}
export function counts(): Record<Table, number> { return Object.fromEntries(Object.keys(TABLES).map(k => [k, 0])) as Record<Table, number>; }
export function checkCounts(actual: Record<Table, number>, expected: Record<Table, number>): void {
  for (const t of Object.keys(TABLES) as Table[]) if (actual[t] !== expected[t]) fail('Backup table count mismatch');
}
export function retentionIds(backups: Manifest[], policy: { daily: number; weekly: number; monthly: number }): Set<string> {
  for (const n of Object.values(policy)) if (!Number.isSafeInteger(n) || n < 1 || n > 10000) fail('Retention counts must be integers from 1 to 10000');
  const retained = new Set<string>();
  const days = new Set<string>(), weeks = new Set<string>(), months = new Set<string>();
  for (const m of [...backups].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))) {
    const day = m.createdAt.slice(0, 10), month = day.slice(0, 7);
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
    const week = d.toISOString().slice(0, 10);
    for (const [set, key, limit] of [[days, day, policy.daily], [weeks, week, policy.weekly], [months, month, policy.monthly]] as const) {
      if (!set.has(key) && set.size < limit) { set.add(key); retained.add(m.id); }
    }
  }
  return retained;
}

export async function boundedBytes(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); fail('Input exceeds size limit'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } finally { reader.releaseLock(); }
}
