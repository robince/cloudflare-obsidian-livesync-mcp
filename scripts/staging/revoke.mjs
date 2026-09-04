import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const role = process.argv[2] ?? 'write';
assert(['read', 'write'].includes(role), 'Expected read or write');
const directory = resolve(import.meta.dirname, '../../.wrangler/conflict-staging');
const config = JSON.parse(await readFile(join(directory, 'mcp.json'), 'utf8'));
const state = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8'));
const tokens = JSON.parse(await readFile(join(directory, 'tokens.json'), 'utf8'));
const origin = new URL(config.vars.MCP_PUBLIC_BASE_URL);
assert(origin.protocol === 'https:' && origin.hostname.startsWith(`${state.mcp}.`), 'Not the generated staging origin');
assert(tokens[role] && tokens[`${role}ClientId`], 'Missing staging token or its issuing client');
const response = await fetch(new URL('/oauth/token', origin), {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ token: tokens[role], token_type_hint: 'access_token', client_id: tokens[`${role}ClientId`] }),
});
assert.equal(response.status, 200, 'Token revocation failed');
// KV propagation may take time. Only a real 401 completes the check.
let revoked = false;
for (let attempt = 0; attempt < 30; attempt++) {
  const check = await fetch(new URL('/mcp', origin), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { authorization: `Bearer ${tokens[role]}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'revocation-check', method: 'tools/list', params: {} }),
  });
  if (check.status === 401) { revoked = true; break; }
  await new Promise(resolve => setTimeout(resolve, 2000));
}
assert(revoked, 'The old staging token still authenticates');
console.log(`Verified revocation: the old ${role} staging token receives HTTP 401. No token printed.`);
