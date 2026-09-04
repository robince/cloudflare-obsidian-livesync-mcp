import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import fixture from '../../../test/fixtures/livesync-1.0.21.json';
import type { JsonObject } from '../../../src/types';

const ORIGIN = 'https://mcp.test';
const REDIRECT_URI = 'https://client.example/callback';
const PKCE_VERIFIER = 'a'.repeat(43);
const PKCE_CHALLENGE = 'ZtNPunH49FD35FWYhT5Tv8I7vRKQJ8uxMaL0_9eHjNA';

type RegisteredClient = { client_id: string };
type TokenResponse = { access_token: string; scope: string; token_type: string };
type StorageSetupRpc = {
  ensureDatabase(name: string): Promise<void>;
  putDocument(name: string, document: JsonObject): Promise<void>;
  getDocument(name: string, id: string, options?: { conflicts?: boolean }): Promise<JsonObject>;
  fetch(request: Request): Promise<Response>;
};

afterEach(() => {
  vi.restoreAllMocks();
});

function workerFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('host', 'mcp.test');
  return SELF.fetch(input, { ...init, headers });
}

async function registerClient(): Promise<RegisteredClient> {
  const response = await workerFetch(`${ORIGIN}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'OAuth integration test',
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  expect(response.status).toBe(201);
  return response.json<RegisteredClient>();
}

function authorizeUrl(clientId: string, scope = 'vault:read'): string {
  const url = new URL('/authorize', ORIGIN);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', 'client-state');
  url.searchParams.set('resource', `${ORIGIN}/mcp`);
  url.searchParams.set('code_challenge', PKCE_CHALLENGE);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

function hiddenValue(html: string, name: string): string {
  const match = html.match(new RegExp(`name="${name}" value="([^"]+)"`));
  if (!match) throw new Error(`Missing ${name} input`);
  return match[1];
}

async function beginGithubFlow() {
  const client = await registerClient();
  const authorize = await workerFetch(authorizeUrl(client.client_id));
  const cookie = authorize.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  const html = await authorize.text();
  const consent = await workerFetch(`${ORIGIN}/authorize/consent`, {
    method: 'POST',
    headers: { cookie },
    body: new URLSearchParams({
      authorization_id: hiddenValue(html, 'authorization_id'),
      csrf_token: hiddenValue(html, 'csrf_token'),
    }),
    redirect: 'manual',
  });
  expect(consent.status).toBe(302);
  const github = new URL(consent.headers.get('location') ?? '');
  expect(github.origin).toBe('https://github.com');
  expect(github.searchParams.get('scope')).toBe('read:user');
  return { client, cookie, githubState: github.searchParams.get('state') ?? '' };
}

function mockGithub(login: string) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
    if (url.pathname === '/login/oauth/access_token') {
      return Response.json({ access_token: 'github-token' });
    }
    if (url.origin === 'https://api.github.com' && url.pathname === '/user') {
      return Response.json({ id: 12345, login });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  });
}

function withoutRevision(document: JsonObject): JsonObject {
  const copy = structuredClone(document);
  delete copy._rev;
  delete copy._revisions;
  delete copy._revs_info;
  delete copy._conflicts;
  return copy;
}

async function seedVault(): Promise<void> {
  const stub = env.POUCH_DATABASES.getByName('test-vault') as unknown as StorageSetupRpc;
  await stub.ensureDatabase('test-vault');
  for (const document of fixture.documents) {
    await stub.putDocument('test-vault', withoutRevision(document as JsonObject));
  }
  for (const document of Object.values(fixture.localDocuments)) {
    await stub.putDocument('test-vault', withoutRevision(document as JsonObject));
  }
}

async function mcpCall(accessToken: string, method: string, params: JsonObject): Promise<JsonObject> {
  const response = await workerFetch(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  const data = response.headers.get('content-type')?.includes('text/event-stream')
    ? text.split('\n').find((line) => line.startsWith('data: '))?.slice(6)
    : text;
  if (!data) throw new Error(`Missing MCP response body: ${text}`);
  const payload = JSON.parse(data) as { error?: unknown; result?: JsonObject };
  expect(payload.error).toBeUndefined();
  if (!payload.result) throw new Error(`Missing MCP result: ${data}`);
  return payload.result;
}

describe('OAuth Worker boundary', () => {
  it('publishes read-only scopes and enforces scope and consent CSRF policy', async () => {
    const metadata = await workerFetch(`${ORIGIN}/.well-known/oauth-authorization-server`);
    await expect(metadata.json()).resolves.toMatchObject({ scopes_supported: ['vault:read'] });

    const client = await registerClient();
    const read = await workerFetch(authorizeUrl(client.client_id));
    expect(read.status).toBe(200);
    expect(await read.text()).toContain('list and read Markdown files');
    expect(read.headers.get('set-cookie')).toContain('__Host-obsidian-mcp-csrf=');
    expect(read.headers.get('content-security-policy')).toContain("form-action 'self' https://github.com");

    const write = await workerFetch(authorizeUrl(client.client_id, 'vault:read vault:write'));
    expect(write.status).toBe(400);
    expect(await write.text()).toBe('Vault writes are disabled.');

    const missingCsrf = await workerFetch(`${ORIGIN}/authorize/consent`, {
      method: 'POST',
      body: new URLSearchParams({ authorization_id: 'missing', csrf_token: 'missing' }),
    });
    expect(missingCsrf.status).toBe(400);
    expect(missingCsrf.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('completes an allowlisted GitHub flow once and rejects callback replay', async () => {
    const { client, cookie, githubState } = await beginGithubFlow();
    expect(githubState).toBeTruthy();
    const fetchSpy = mockGithub('RobinCE');

    const callbackUrl = `${ORIGIN}/oauth/github/callback?code=github-code&state=${githubState}`;
    const callback = await workerFetch(callbackUrl, { headers: { cookie }, redirect: 'manual' });
    expect(callback.status).toBe(302);
    const clientRedirect = new URL(callback.headers.get('location') ?? '');
    expect(clientRedirect.origin).toBe('https://client.example');
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const token = await workerFetch(`${ORIGIN}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: clientRedirect.searchParams.get('code') ?? '',
        redirect_uri: REDIRECT_URI,
        code_verifier: PKCE_VERIFIER,
        resource: `${ORIGIN}/mcp`,
        scope: 'vault:read',
      }),
    });
    expect(token.status).toBe(200);
    const tokenPayload = await token.json<TokenResponse>();
    expect(tokenPayload).toMatchObject({
      access_token: expect.any(String),
      scope: 'vault:read',
      token_type: 'bearer',
    });

    await seedVault();
    await expect(mcpCall(tokenPayload.access_token, 'tools/call', {
      name: 'vault_status', arguments: {},
    })).resolves.toMatchObject({ structuredContent: { compatible: true } });
    await expect(mcpCall(tokenPayload.access_token, 'tools/call', {
      name: 'list_files', arguments: { prefix: 'notes/' },
    })).resolves.toMatchObject({
      structuredContent: {
        files: expect.arrayContaining([expect.objectContaining({ path: 'notes/unicode-雪.md' })]),
      },
    });
    await expect(mcpCall(tokenPayload.access_token, 'tools/call', {
      name: 'read_file', arguments: { path: 'notes/unicode-雪.md' },
    })).resolves.toMatchObject({
      structuredContent: { content: fixture.files['notes/unicode-雪.md'] },
    });

    const storage = env.POUCH_DATABASES.getByName('test-vault') as unknown as StorageSetupRpc;
    const path = 'notes/http-conflict.md';
    const docs = ['a', 'b'].map(rev => ({
      _id: path, _rev: `1-${rev}`, path, type: 'plain', datatype: 'plain',
      children: [], eden: {}, size: 0, ctime: 1, mtime: 1,
    }));
    const inserted = await storage.fetch(new Request('https://test/_bulk_docs', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-pouchdb-database': 'test-vault' },
      body: JSON.stringify({ docs, new_edits: false }),
    }));
    expect(inserted.status).toBe(201);
    const before = await storage.getDocument('test-vault', path, { conflicts: true });
    expect(await mcpCall(tokenPayload.access_token, 'tools/call', { name: 'read_file', arguments: { path } }))
      .toMatchObject({ isError: true, structuredContent: { error: {
        code: 'livesync_conflict', path, unresolvedVersions: 2, resolution: 'obsidian',
        message: expect.stringContaining('full Obsidian client'),
      } } });
    expect(await storage.getDocument('test-vault', path, { conflicts: true })).toEqual(before);

    const replay = await workerFetch(callbackUrl, { headers: { cookie }, redirect: 'manual' });
    expect(replay.status).toBe(400);
    expect(await replay.text()).toBe('GitHub authorization has expired.');
  });

  it('rejects a GitHub login outside the runtime allowlist', async () => {
    const { cookie, githubState } = await beginGithubFlow();
    mockGithub('intruder');
    const callback = await workerFetch(
      `${ORIGIN}/oauth/github/callback?code=github-code&state=${githubState}`,
      { headers: { cookie }, redirect: 'manual' },
    );
    expect(callback.status).toBe(403);
    expect(await callback.text()).toBe('This GitHub account is not allowed.');
    expect(callback.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});
