// Real DCR + PKCE flow; the user completes GitHub login/consent in their browser.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const role = process.argv[2] ?? 'read';
assert(['read', 'write'].includes(role), 'Expected read or write');
const directory = resolve(import.meta.dirname, '../../.wrangler/conflict-staging');
const config = JSON.parse(await readFile(join(directory, 'mcp.json'), 'utf8'));
const origin = config.vars.MCP_PUBLIC_BASE_URL;
const verifier = randomBytes(32).toString('base64url');
const state = randomBytes(32).toString('base64url');
const scope = role === 'write' ? 'vault:read vault:write' : 'vault:read';
let finish;
const callback = new Promise(resolve => { finish = resolve; });
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname !== '/callback' || url.searchParams.get('state') !== state || !url.searchParams.get('code')) {
    response.writeHead(400).end('Invalid staging authorization callback.'); return;
  }
  response.writeHead(200, { 'content-type': 'text/plain' }).end('Staging authorization received. You may close this tab.');
  finish(url.searchParams.get('code'));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const redirect = `http://127.0.0.1:${server.address().port}/callback`;
const request = async (path, body, json = true) => {
  const result = await fetch(`${origin}${path}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { 'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded' },
    body: json ? JSON.stringify(body) : new URLSearchParams(body),
  });
  assert(result.ok, 'Staging OAuth request failed');
  return result.json();
};
try {
  const client = await request('/oauth/register', { client_name: 'Disposable conflict staging',
    redirect_uris: [redirect], token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  });
  const url = new URL('/authorize', origin);
  for (const [key, value] of Object.entries({ response_type: 'code', client_id: client.client_id,
    redirect_uri: redirect, scope, resource: `${origin}/mcp`, state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })) url.searchParams.set(key, value);
  console.log(`Open this staging consent URL (${role} access to the disposable database only):\n${url}`);
  let timer;
  const code = await Promise.race([callback, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Staging authorization timed out')), 600000); })]);
  clearTimeout(timer);
  const token = await request('/oauth/token', { grant_type: 'authorization_code', client_id: client.client_id,
    redirect_uri: redirect, code_verifier: verifier, code, resource: `${origin}/mcp`, scope }, false);
  const file = join(directory, 'tokens.json');
  const tokens = await readFile(file, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return {}; throw error; });
  tokens[role] = token.access_token;
  tokens[`${role}ClientId`] = client.client_id;
  await writeFile(file, JSON.stringify(tokens), { mode: 0o600 });
  console.log(`Saved ${role} staging token to the ignored local token file. No token printed.`);
} finally { server.close(); }
