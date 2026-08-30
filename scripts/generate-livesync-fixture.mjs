#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const RELEASE = '1.0.21';
const COMMIT = 'f5f7aab11f03f62c6946d2fa296c50bb5df5b2a4';
const COMMONLIB = '0.1.19';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

function capture(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8' }).trim();
}

function archiveTag(repository, destination) {
  mkdirSync(destination, { recursive: true });
  const archive = spawnSync('git', ['-C', repository, 'archive', '--format=tar', RELEASE], {
    encoding: null,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (archive.status !== 0) throw new Error(archive.stderr?.toString() || 'git archive failed');
  const extract = spawnSync('tar', ['-xf', '-', '-C', destination], {
    input: archive.stdout,
    encoding: null,
  });
  if (extract.status !== 0) throw new Error(extract.stderr?.toString() || 'tar extraction failed');
}

function cli(commandPath, vault, settings, ...args) {
  run(process.execPath, [commandPath, vault, '--settings', settings, ...args]);
}

async function requestJson(url, user, password, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`);
  if (init.body) headers.set('content-type', 'application/json');
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) throw new Error(`${init.method || 'GET'} ${url}: ${response.status} ${await response.text()}`);
  return response.json();
}

function configure(path, endpoint, database, user, password) {
  const settings = JSON.parse(readFileSync(path, 'utf8'));
  Object.assign(settings, {
    remoteType: '',
    couchDB_URI: endpoint,
    couchDB_DBNAME: database,
    couchDB_USER: user,
    couchDB_PASSWORD: password,
    liveSync: true,
    isConfigured: true,
    syncOnSave: false,
    syncOnStart: false,
    usePluginSync: false,
    encrypt: false,
    passphrase: '',
    usePathObfuscation: false,
    enableCompression: false,
    handleFilenameCaseSensitive: false,
  });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

async function main() {
  const endpoint = new URL(option('--endpoint', 'http://127.0.0.1:8787'));
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) {
    throw new Error('Fixture generation is restricted to a loopback endpoint.');
  }
  const repository = resolve(option('--livesync-repo', '../obsidian-livesync'));
  const output = resolve(option('--output', 'test/fixtures/livesync-1.0.21.json'));
  const tagCommit = capture('git', ['rev-list', '-n', '1', RELEASE], repository);
  if (tagCommit !== COMMIT) throw new Error(`Unexpected ${RELEASE} commit: ${tagCommit}`);

  const user = 'admin';
  const password = 'test-password';
  const database = 'mcp-fixture-livesync-1-0-21';
  const root = mkdtempSync(join(tmpdir(), 'livesync-1.0.21-'));
  try {
    const source = join(root, 'source');
    archiveTag(repository, source);
    const lock = JSON.parse(readFileSync(join(source, 'package-lock.json'), 'utf8'));
    const locked = lock.packages?.['node_modules/@vrtmrz/livesync-commonlib']?.version;
    if (locked !== COMMONLIB) throw new Error(`${RELEASE} pins Commonlib ${locked}, expected ${COMMONLIB}`);
    run('npm', ['ci'], source);
    run('npm', ['run', 'build', '--workspace', 'self-hosted-livesync-cli'], source);
    const commandPath = join(source, 'src/apps/cli/dist/index.cjs');

    const vaultA = join(root, 'vault-a');
    const vaultB = join(root, 'vault-b');
    const settingsA = join(root, 'settings-a.json');
    const settingsB = join(root, 'settings-b.json');
    mkdirSync(vaultA, { recursive: true });
    mkdirSync(vaultB, { recursive: true });
    run(process.execPath, [commandPath, 'init-settings', '--force', settingsA]);
    run(process.execPath, [commandPath, 'init-settings', '--force', settingsB]);
    const origin = endpoint.href.replace(/\/$/, '');
    configure(settingsA, origin, database, user, password);
    configure(settingsB, origin, database, user, password);
    await requestJson(`${origin}/${database}`, user, password, { method: 'PUT' });

    const files = {
      'notes/frontmatter.md': '---\ntitle: MCP fixture\n---\n\n# Current LiveSync\n',
      'notes/crlf.md': '# CRLF\r\nfirst\r\nsecond\r\n',
      'notes/unicode-雪.md': '# Unicode\nnaïve façade — Ελληνικά — 🙂\n',
      'notes/chunked.md': `# Chunked\n${'current livesync fixture line 0123456789\n'.repeat(1200)}`,
    };
    for (const [path, content] of Object.entries(files)) {
      const localPath = join(root, 'ground-truth', path);
      mkdirSync(dirname(localPath), { recursive: true });
      writeFileSync(localPath, content);
      cli(commandPath, vaultA, settingsA, 'push', localPath, path);
    }
    cli(commandPath, vaultA, settingsA, 'sync');
    cli(commandPath, vaultB, settingsB, 'sync');
    for (const [path, expected] of Object.entries(files)) {
      const localPath = join(root, 'round-trip', path);
      mkdirSync(dirname(localPath), { recursive: true });
      cli(commandPath, vaultB, settingsB, 'pull', path, localPath);
      if (readFileSync(localPath, 'utf8') !== expected) throw new Error(`${path} did not round-trip`);
    }

    const allDocs = await requestJson(`${origin}/${database}/_all_docs?include_docs=true`, user, password);
    const localDocuments = {};
    for (const id of ['_local/obsydian_livesync_milestone', '_local/obsidian_livesync_sync_parameters']) {
      localDocuments[id] = await requestJson(
        `${origin}/${database}/${id.split('/').map(encodeURIComponent).join('/')}`,
        user,
        password,
      );
    }
    const metadata = allDocs.rows.map((row) => row.doc).find((doc) => doc?.path === 'notes/chunked.md');
    if (!Array.isArray(metadata?.children) || metadata.children.length < 2) {
      throw new Error('The representative large note was not chunked.');
    }

    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify({
      schemaVersion: 1,
      producer: { release: RELEASE, commit: COMMIT, commonlib: COMMONLIB },
      files,
      documents: allDocs.rows.map((row) => row.doc).filter(Boolean),
      localDocuments,
    }, null, 2)}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
