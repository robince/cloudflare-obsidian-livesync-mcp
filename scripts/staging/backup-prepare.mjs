// Prepare a separate disposable deployment. Never reads or changes production configuration.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
const root = resolve(import.meta.dirname, '../..');
const directory = join(root, '.wrangler/backup-staging');
await mkdir(directory, { recursive: true, mode: 0o700 });
const suffix = randomBytes(6).toString('hex');
const config = JSON.parse(await readFile(join(root, 'wrangler.jsonc'), 'utf8'));
config.name = `livesync-backup-staging-${suffix}`;
config.main = join(root, 'src/index.ts');
config.alias['octagonal-wheels/hash/xxhash.js'] = join(root, 'src/livesync-vault/worker-xxhash.ts');
config.vars.BACKUP_DATABASE = `backup-staging-${suffix}`;
// Keep the hourly trigger for provisioning verification; no source exists until the smoke run.
delete config.$schema;
await writeFile(join(directory, 'storage.json'), JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
await writeFile(join(directory, 'secrets.json'), JSON.stringify({ COUCHDB_PASSWORD: randomBytes(32).toString('base64url') }), { flag: 'wx', mode: 0o600 });
console.log('Prepared .wrangler/backup-staging. No resources deployed.');
