import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const mode = process.argv[2];
assert(['scope', 'disabled'].includes(mode), 'Choose scope or disabled');
const directory = resolve(import.meta.dirname, '../../.wrangler/conflict-staging');
const load = async name => JSON.parse(await readFile(join(directory, name), 'utf8'));
const [config, state, tokens, secrets] = await Promise.all(
  ['mcp.json', 'runtime.json', 'tokens.json', 'storage-secrets.json'].map(load));
const origin = new URL(config.vars.MCP_PUBLIC_BASE_URL);
assert(origin.protocol === 'https:' && origin.hostname.startsWith(`${state.mcp}.`));
assert.equal(config.vars.VAULT_DATABASE, state.database);
assert(/^mcp-conflict-staging-[a-z0-9]{8,40}$/.test(state.database));
const storage = new URL(origin);
storage.hostname = origin.hostname.replace(`${state.mcp}.`, `${state.storage}.`);
const raw = path => fetch(`${storage.origin}/${state.database}/${path}`, {
  redirect: 'error', signal: AbortSignal.timeout(30000),
  headers: { authorization: `Basic ${Buffer.from(`admin:${secrets.COUCHDB_PASSWORD}`).toString('base64')}` },
});
const client = new Client({ name: 'staging-fresh-access-verifier', version: '1' });
try {
  const old = await fetch(`${origin.origin}/mcp`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { authorization: `Bearer ${tokens.write}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(old.status, 401, 'Revoked write token authenticated');
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin), {
    requestInit: { headers: { authorization: `Bearer ${tokens.read}` }, redirect: 'error' },
  }));
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.equal(names.includes('create_file'), mode === 'scope');
  const before = await raw('staging-safe.md?conflicts=true');
  assert.equal(before.status, 200);
  const tree = await before.json();
  const read = await client.callTool({ name: 'read_file', arguments: { path: 'staging-safe.md' } });
  assert(!read.isError);
  assert.equal(typeof read.structuredContent?.content, 'string');
  assert.equal((await raw('staging-access-probe.md')).status, 404);
  const denied = await client.callTool({ name: 'create_file', arguments: {
    path: 'staging-access-probe.md', content: 'This must never be written by a read grant.',
  } }).catch(error => {
    if (mode === 'disabled' && error.code === -32602) return { isError: true };
    throw error;
  });
  assert.equal(denied.isError, true);
  if (mode === 'scope') assert(denied.content?.some(item =>
    item.type === 'text' && item.text.includes('vault:write scope')),
  'Expected the explicit write-scope authorization denial');
  assert.equal((await raw('staging-access-probe.md')).status, 404);
  assert.deepEqual(await (await raw('staging-safe.md?conflicts=true')).json(), tree);
  console.log(`Passed ${mode}: fresh read works, writes denied without mutation, revoked write token remains HTTP 401.`);
} catch {
  console.error('Staging access verification failed. No credentials or response bodies printed.');
  process.exitCode = 1;
} finally { await client.close(); }
