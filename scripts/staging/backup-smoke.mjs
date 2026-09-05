import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { main as backup } from '../backup.mjs';
const directory = resolve('.wrangler/backup-staging');
const config = JSON.parse(await readFile(join(directory, 'storage.json'), 'utf8'));
const secrets = JSON.parse(await readFile(join(directory, 'secrets.json'), 'utf8'));
const url = new URL(process.env.STAGING_BACKUP_URL ?? '');
assert(url.protocol === 'https:' && url.hostname.startsWith(`${config.name}.`) && url.hostname.endsWith('.workers.dev'));
assert(config.name.startsWith('livesync-backup-staging-'));
const name = config.vars.BACKUP_DATABASE;
const headers = { authorization: `Basic ${Buffer.from(`admin:${secrets.COUCHDB_PASSWORD}`).toString('base64')}`, 'content-type': 'application/json' };
const call = async (path, method = 'GET', body) => {
  const response = await fetch(new URL(path, url), { method, headers, body: body ? JSON.stringify(body) : undefined });
  assert(response.ok, `HTTP ${response.status}: ${await response.clone().text()}`);
  return response.json();
};
const fixture = JSON.parse(await readFile('test/fixtures/livesync-1.0.21.json', 'utf8'));
await call(`/${name}`, 'PUT');
await call(`/${name}/_bulk_docs`, 'POST', { docs: fixture.documents, new_edits: false });
for (const original of Object.values(fixture.localDocuments)) {
  const doc = { ...original }; delete doc._rev;
  await call(`/${name}/${doc._id}`, 'PUT', doc);
}
const measurements = [];
for (const count of [0, 10, 100]) {
  // Incompressible synthetic chunks exercise R2 size and multiple parts without private content.
  for (let i = count === 100 ? 10 : 0; i < count; i++) await call(`/${name}/h:benchmark-${i}`, 'PUT', { type: 'leaf', data: randomBytes(75000).toString('base64') });
  const before = await call(`/${name}`), started = Date.now();
  const m = await call(`/_backup?database=${name}`, 'POST');
  measurements.push({ chunks: count, databaseBytes: before.sizes.file, backupBytes: m.bytes, pauseMs: m.pauseMs, wallMs: Date.now() - started, parts: m.parts.length });
}
process.env.COUCHDB_PASSWORD = secrets.COUCHDB_PASSWORD;
const list = await call(`/_backup?database=${name}`);
const id = list[0].id;
const output = await mkdtemp(join(tmpdir(), 'livesync-backup-smoke-'));
const args = ['--url', url.origin, '--database', name, '--id', id];
await backup(['download', ...args, '--out', join(output, 'archive')]);
await backup(['verify', '--dir', join(output, 'archive')]);
const extracted = await backup(['extract', '--dir', join(output, 'archive'), '--out', join(output, 'extracted')]);
assert.equal(extracted.issues.length, 0);
for (const [path, text] of Object.entries(fixture.files)) assert.equal(await readFile(join(output, 'extracted/vault', path), 'utf8'), text);
const target = `${name}-restored`;
await backup(['restore', ...args, '--target', target]);
const sourceDoc = await call(`/${name}/notes%2Ffrontmatter.md`), targetDoc = await call(`/${target}/notes%2Ffrontmatter.md`);
assert.equal(sourceDoc._rev, targetDoc._rev);
assert.deepEqual((await call(`/${target}/_local/obsydian_livesync_milestone`)).accepted_nodes, []);
await writeFile(join(directory, 'smoke.json'), JSON.stringify({ url: url.origin, database: name, target, id, output, measurements }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ passed: true, measurements, output }, null, 2));
