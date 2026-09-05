import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir, mkdtemp, rm, open, stat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { TABLES, counts, checkCounts, manifestFrom, unpack, decodeCell, MAX_MANIFEST_BYTES, DATABASE_NAME, boundedBytes } from '../src/backup/format.ts';
// The pinned Commonlib package ships its codec beside LiveSyncLocalDB but does not export it.
// Reuse that exact codec; the extraction regression protects this package boundary.
const { decompressDoc } = await import(new URL('./compress.js', import.meta.resolve('@vrtmrz/livesync-commonlib/compat/pouchdb/LiveSyncLocalDB')));
import { decodeBinary } from '@vrtmrz/livesync-commonlib/compat/string_and_binary/convert';

export async function localManifest(directory) {
  const file = join(directory, 'manifest.json');
  if ((await stat(file)).size > MAX_MANIFEST_BYTES) throw new Error('Manifest too large');
  return manifestFrom(JSON.parse(await readFile(file, 'utf8')));
}
export async function verifyLocal(directory, onRows = () => {}) {
  const m = await localManifest(directory), actual = counts();
  for (const part of m.parts) {
    const file = join(directory, part.file);
    if ((await stat(file)).size !== part.bytes) throw new Error('Part size mismatch');
    const rows = unpack(new Uint8Array(await readFile(file)), part);
    rows.forEach(row => actual[row.table]++);
    await onRows(rows);
  }
  checkCounts(actual, m.tables);
  return m;
}
export function safePath(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || /[\\\x00-\x1f<>:"|?*]/.test(path)
    || path.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) {
    throw new Error('Unsafe or non-portable vault path');
  }
  return path;
}
export async function extract(directory, output) {
  const temporary = await mkdtemp(join(tmpdir(), 'livesync-backup-'));
  const db = new DatabaseSync(join(temporary, 'backup.sqlite'));
  const report = { files: 0, issues: [] };
  try {
    for (const [table, columns] of Object.entries(TABLES)) {
      if (table === 'sqlite_sequence') continue;
      db.exec(`CREATE TABLE "${table}" (${columns.map(c => `"${c}"${table === 'by-sequence' && c === 'seq' ? ' INTEGER PRIMARY KEY AUTOINCREMENT' : ''}`).join(',')})`);
    }
    await verifyLocal(directory, rows => {
      db.exec('BEGIN');
      try {
        for (const row of rows) {
          if (row.table === 'sqlite_sequence') continue;
          const columns = TABLES[row.table];
          db.prepare(`INSERT INTO "${row.table}" VALUES (${columns.map(() => '?').join(',')})`).run(...row.values.map(decodeCell));
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
    db.exec('CREATE INDEX docs_id ON "document-store" (id)');
    const milestone = db.prepare('SELECT json FROM "local-store" WHERE id=?').get('_local/obsydian_livesync_milestone');
    const tweaks = milestone && JSON.parse(milestone.json).tweak_values?.PREFERRED;
    if (!tweaks || tweaks.encrypt !== false || tweaks.usePathObfuscation !== false) throw new Error('Extraction requires an unencrypted, unobfuscated LiveSync backup');
    // A newly-created output tree plus exclusive file creation prevents traversing pre-existing symlinks.
    await mkdir(output, { recursive: false, mode: 0o700 });
    await mkdir(join(output, 'vault'), { mode: 0o700 });
    const paths = new Set();
    const winner = db.prepare('SELECT b.json,b.deleted,b.rev FROM "document-store" d JOIN "by-sequence" b ON d.winningseq=b.seq WHERE d.id=?');
    for (const row of db.prepare('SELECT d.id,d.json AS metadata,b.json,b.deleted,b.rev FROM "document-store" d JOIN "by-sequence" b ON d.winningseq=b.seq ORDER BY d.winningseq').iterate()) {
      const entry = JSON.parse(row.json);
      if (typeof entry.path !== 'string' || row.deleted || entry.deleted || entry._deleted) continue;
      const path = entry.path;
      let file;
      try {
        safePath(path);
        const key = path.normalize('NFC').toLowerCase();
        if (paths.has(key)) throw new Error('Output path collision');
        paths.add(key);
        const type = entry.datatype ?? entry.type;
        if (!['plain', 'newnote'].includes(type) || !Array.isArray(entry.children)) throw new Error('Unsupported file format');
        const leaves = [];
        const visit = (ids, pos) => { if (ids[2].length === 0) { if (!ids[1].deleted) leaves.push(`${pos}-${ids[0]}`); } else ids[2].forEach(child => visit(child, pos + 1)); };
        for (const branch of JSON.parse(row.metadata).rev_tree ?? []) visit(branch.ids, branch.pos);
        if (leaves.length > 1) report.issues.push({ path, reason: 'Conflicting revisions; extracted database winner', revisions: leaves });
        const destination = join(output, 'vault', path);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        file = await open(destination, 'wx', 0o600);
        for (const id of entry.children) {
          if (typeof id !== 'string') throw new Error('Invalid chunk reference');
          let data = entry.eden?.[id]?.data;
          if (typeof data !== 'string') {
            const chunkRow = winner.get(id);
            if (!chunkRow || chunkRow.deleted) throw new Error(`Missing chunk: ${id}`);
            const chunk = await decompressDoc(JSON.parse(chunkRow.json));
            if (chunk.type !== 'leaf' || typeof chunk.data !== 'string') throw new Error(`Unreadable chunk: ${id}`);
            data = chunk.data;
          }
          await file.writeFile(type === 'plain' ? data : new Uint8Array(decodeBinary(data)));
        }
        await file.close(); file = undefined; report.files++;
      } catch (error) {
        if (file) { await file.close(); await rm(join(output, 'vault', path)); }
        report.issues.push({ path, reason: error.message });
      }
    }
    await writeFile(join(output, 'extraction-report.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
    return report;
  } finally { db.close(); await rm(temporary, { recursive: true, force: true }); }
}

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    url: { type: 'string' }, database: { type: 'string' }, id: { type: 'string' },
    dir: { type: 'string' }, out: { type: 'string' }, target: { type: 'string' }, restart: { type: 'boolean' },
  } });
  const command = positionals[0];
  if (command === 'verify' && values.dir) { await verifyLocal(resolve(values.dir)); return { ok: true }; }
  if (command === 'extract') {
    if (!values.dir || !values.out) throw new Error('extract requires --dir and --out (a new directory)');
    const report = await extract(resolve(values.dir), resolve(values.out));
    if (report.issues.length) process.exitCode = 2;
    return report;
  }
  if (!['create', 'list', 'status', 'download', 'verify', 'restore'].includes(command)) throw new Error('Use create, list, status, download, verify, extract, or restore');
  const url = new URL(values.url ?? process.env.BACKUP_URL ?? '');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('Use an HTTPS Worker origin without credentials (HTTP allowed on localhost)');
  const password = process.env.COUCHDB_PASSWORD;
  if (!password) throw new Error('Set COUCHDB_PASSWORD in the environment or use Node --env-file');
  const database = values.database ?? process.env.BACKUP_DATABASE ?? 'vault';
  if (!DATABASE_NAME.test(database)) throw new Error('Invalid database name');
  const call = async (suffix = '', method = 'GET', body) => {
    const endpoint = new URL(`/_backup${suffix}`, url);
    endpoint.searchParams.set('database', database);
    const response = await fetch(endpoint, { method, redirect: 'error', headers: {
      authorization: `Basic ${Buffer.from(`${process.env.COUCHDB_USERNAME ?? 'admin'}:${password}`).toString('base64')}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    }, body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error(`Backup operation failed (${response.status}): ${await response.text()}`);
    return response;
  };
  if (command === 'create') return (await call('', 'POST')).json();
  if (command === 'list') return (await call()).json();
  if (command === 'status') return (await call('/status')).json();
  if (!values.id) throw new Error('This operation requires --id');
  if (command === 'restore') {
    if (!values.target) throw new Error('restore requires --target (an unused database name)');
    return (await call('/restore', 'POST', { id: values.id, target: values.target, restart: !!values.restart })).json();
  }
  if (command === 'verify') return (await call(`/${encodeURIComponent(values.id)}/verify`, 'POST')).json();
  if (!values.out) throw new Error('download requires --out (a new directory)');
  const manifestResponse = await call(`/${encodeURIComponent(values.id)}/manifest.json`);
  const m = manifestFrom(JSON.parse(new TextDecoder().decode(await boundedBytes(manifestResponse.body, MAX_MANIFEST_BYTES))));
  const output = resolve(values.out);
  await mkdir(output, { recursive: false, mode: 0o700 });
  for (const part of m.parts) {
    const response = await call(`/${encodeURIComponent(values.id)}/${part.file}`);
    const bytes = await boundedBytes(response.body, part.bytes);
    unpack(bytes, part);
    await writeFile(join(output, part.file), bytes, { flag: 'wx', mode: 0o600 });
  }
  await writeFile(join(output, 'manifest.json'), JSON.stringify(m, null, 2), { flag: 'wx', mode: 0o600 });
  await verifyLocal(output);
  return { ok: true, directory: output, bytes: m.bytes };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
