import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { counts, pack, hash, retentionIds, unpack, manifestFrom } from '../src/backup/format.ts';
import { extract, verifyLocal, safePath } from '../scripts/backup.mjs';
const { compressDoc } = await import(new URL('./compress.js', import.meta.resolve('@vrtmrz/livesync-commonlib/compat/pouchdb/LiveSyncLocalDB')));

const m = date => ({ format: 1, id: `${Date.parse(date)}-${randomUUID()}`, database: 'vault', createdAt: new Date(date).toISOString(), adapter: '1.1.2-cloudflare-do.0', application: '0.1.0', tables: counts(), parts: [], bytes: 0, pauseMs: 1 });
test('retention keeps latest representatives, overlaps once, and survives long gaps', () => {
  const backups = Array.from({ length: 1000 }, (_, i) => m(new Date(Date.UTC(2026, 8, 5 - i))));
  const keep = retentionIds(backups, { daily: 30, weekly: 8, monthly: 24 });
  assert(keep.size <= 62 && keep.size >= 30);
  backups.slice(0, 30).forEach(b => assert(keep.has(b.id)));
  const duplicate = { ...backups[0], id: `${Date.parse(backups[0].createdAt)}-${randomUUID()}`, createdAt: backups[0].createdAt.replace('00:00:', '12:00:') };
  const selected = retentionIds([duplicate, ...backups], { daily: 1, weekly: 1, monthly: 1 });
  assert.deepEqual([...selected], [duplicate.id]);
  assert.equal(retentionIds([m('2020-02-29'), m('2010-01-01')], { daily: 30, weekly: 8, monthly: 24 }).size, 2);
  assert.equal(retentionIds([m('2021-01-03'), m('2020-12-31')], { daily: 1, weekly: 1, monthly: 1 }).size, 1);
});
async function archive(directory, broken = false) {
  const rows = [];
  let seq = 0;
  const doc = (id, body) => {
    seq++;
    rows.push({ table: 'document-store', values: [id, JSON.stringify({ id, rev_tree: [{ pos: 1, ids: ['abc', { status: 'available' }, []] }] }), seq, seq] });
    rows.push({ table: 'by-sequence', values: [seq, JSON.stringify(body), 0, id, '1-abc'] });
  };
  const text = '# Unicode 雪\n' + 'compress me '.repeat(1000);
  doc('h:text', await compressDoc({ type: 'leaf', data: text }));
  doc('notes/雪.md', { path: 'notes/雪.md', type: 'plain', children: ['h:text'], eden: {} });
  doc('inline.md', { path: 'inline.md', type: 'plain', children: ['h:inline'], eden: { 'h:inline': { data: 'inline\n' } } });
  // LiveSync's current binary encoder is reused to produce the attachment fixture.
  const { encodeBinary } = await import('@vrtmrz/livesync-commonlib/compat/string_and_binary/convert');
  const binary = new Uint8Array([0, 1, 2, 128, 255]);
  doc('h:binary', { type: 'leaf', data: (await encodeBinary(binary.buffer)).join('') });
  doc('images/a.bin', { path: 'images/a.bin', type: 'newnote', children: ['h:binary'], eden: {} });
  doc('deleted.md', { path: 'deleted.md', type: 'plain', children: [], deleted: true });
  if (broken) {
    const metadata = rows.find(row => row.table === 'document-store' && row.values[0] === 'inline.md');
    const tree = JSON.parse(metadata.values[1]);
    tree.rev_tree.push({ pos: 1, ids: ['other', { status: 'available' }, []] });
    metadata.values[1] = JSON.stringify(tree);
    doc('missing.md', { path: 'missing.md', type: 'plain', children: ['h:missing'] });
    doc('unsafe', { path: '../escape.md', type: 'plain', children: [] });
    doc('collision', { path: 'INLINE.md', type: 'plain', children: [] });
  }
  rows.push({ table: 'local-store', values: ['_local/obsydian_livesync_milestone', '0-1', JSON.stringify({ tweak_values: { PREFERRED: { encrypt: false, usePathObfuscation: false } } })] });
  const manifest = m('2026-09-05');
  const lines = rows.map(row => JSON.stringify(row) + '\n');
  const bytes = pack(lines);
  rows.forEach(row => manifest.tables[row.table]++);
  manifest.parts.push({ file: '000000.jsonl.gz', bytes: bytes.length, rawBytes: Buffer.byteLength(lines.join('')), rows: rows.length, sha256: hash(bytes) });
  manifest.bytes = bytes.length;
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(directory, '000000.jsonl.gz'), bytes);
  return { text, binary, manifest, bytes };
}
test('offline verification/extraction reconstructs compressed, inline and binary content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'backup-test-'));
  try {
    const { text, binary } = await archive(dir);
    await verifyLocal(dir);
    const out = join(dir, 'output');
    const report = await extract(dir, out);
    assert.deepEqual(report, { files: 3, issues: [] });
    assert.equal(await readFile(join(out, 'vault/notes/雪.md'), 'utf8'), text);
    assert.equal(await readFile(join(out, 'vault/inline.md'), 'utf8'), 'inline\n');
    assert.deepEqual(new Uint8Array(await readFile(join(out, 'vault/images/a.bin'))), binary);
    await assert.rejects(extract(dir, out), /EEXIST/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('extraction reports missing chunks and unsafe/colliding names; cannot follow an output symlink', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'backup-test-'));
  try {
    await archive(dir, true);
    const report = await extract(dir, join(dir, 'output'));
    assert.equal(report.issues.length, 4);
    assert.deepEqual(report.issues.find(issue => issue.path === 'inline.md').revisions, ['1-abc', '1-other']);
    assert.equal(await readFile(join(dir, 'output/vault/inline.md'), 'utf8'), 'inline\n');
    await assert.rejects(readFile(join(dir, 'output/vault/missing.md')));
    await symlink(join(dir, 'output'), join(dir, 'link'));
    await assert.rejects(extract(dir, join(dir, 'link')), /EEXIST/);
    for (const path of ['../x', '/x', 'a\\b', 'CON', 'a/../b', 'a/./b', 'a\u0000b']) assert.throws(() => safePath(path));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('verification rejects corrupted parts, forged counts and table names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'backup-test-'));
  try {
    const { manifest } = await archive(dir);
    assert.throws(() => unpack(new Uint8Array([0]), manifest.parts[0]), /checksum/);
    assert.throws(() => manifestFrom({ ...manifest, format: 2 }), /Unsupported/);
    manifest.tables['by-sequence']++;
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(verifyLocal(dir), /count mismatch/);
    const invalid = pack([JSON.stringify({ table: 'evil', values: [] }) + '\n']);
    assert.throws(() => unpack(invalid, { ...manifest.parts[0], bytes: invalid.length, sha256: hash(invalid), rows: 1, rawBytes: Buffer.byteLength(JSON.stringify({ table: 'evil', values: [] }) + '\n') }), /table/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
