import {
  AuthorizationError,
  OAuthProvider,
  type AuthRequest,
  type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { createMcpHandler } from 'agents/mcp/server';

import { allowedGithubLogins, normalizeGithubLogin } from './auth-utils';
import { vaultRpcForEnv } from './vault-rpc';
import { createVaultMcpServer } from './vault-tools';

const READ_SCOPE = 'vault:read';
const AUTH_STATE_TTL_SECONDS = 10 * 60;
const CSRF_COOKIE = '__Host-obsidian-mcp-csrf';

type McpAuthProps = {
  githubUserId: string;
  githubLogin: string;
  scopes: string[];
};

type OAuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

type GithubAuthorizationState = {
  request: AuthRequest;
  session: string;
};

type GithubSecrets = {
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
};

class McpApi extends WorkerEntrypoint<Env, McpAuthProps> {
  fetch(request: Request): Promise<Response> {
    const origin = publicOrigin(this.env);
    return createMcpHandler(
      () => createVaultMcpServer(vaultRpcForEnv(this.env)),
      {
        route: '/mcp',
        allowedHostnames: [origin.hostname],
        allowedOriginHostnames: [origin.hostname],
        authContext: { props: this.ctx.props },
      },
    )(request, this.env, this.ctx);
  }
}

/** The provider owns OAuth token, refresh, PKCE, CIMD, and DCR mechanics. */
function providerFor(env: Env): OAuthProvider<Env> {
  const origin = publicOrigin(env);
  const resource = new URL('/mcp', origin).toString();
  return new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: McpApi,
    defaultHandler: {
      fetch: async (request, handlerEnv) => handleAuthRequest(request, handlerEnv as OAuthEnv),
    },
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [READ_SCOPE],
    tokenExchangeCallback: ({ props, requestedScope }) => ({
      accessTokenProps: { ...props, scopes: requestedScope },
    }),
    resourceMetadata: {
      resource,
      authorization_servers: [origin.origin],
      scopes_supported: [READ_SCOPE],
      resource_name: 'Obsidian LiveSync vault',
    },
  });
}

async function handleAuthRequest(request: Request, env: OAuthEnv): Promise<Response> {
  if (!isCanonicalRequest(request, env)) return new Response('Invalid host.', { status: 400 });
  const url = new URL(request.url);

  if (url.pathname === '/authorize' && request.method === 'GET') {
    return startAuthorization(request, env);
  }
  if (url.pathname === '/authorize/consent' && request.method === 'POST') {
    return continueToGithub(request, env);
  }
  if (url.pathname === '/oauth/github/callback' && request.method === 'GET') {
    return completeGithubAuthorization(request, env);
  }
  return new Response('Not found.', { status: 404 });
}

async function startAuthorization(request: Request, env: OAuthEnv): Promise<Response> {
  let authorization: AuthRequest;
  try {
    authorization = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    return authorizationFailure(error);
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(authorization.clientId);
  if (!client) return new Response('Unknown OAuth client.', { status: 400 });
  if (!authorization.scope.includes(READ_SCOPE)) {
    return new Response('The vault:read scope is required.', { status: 400 });
  }

  const id = randomToken();
  const csrf = randomToken();
  await env.OAUTH_KV.put(
    authorizationKey(id),
    JSON.stringify({ request: authorization, session: csrf } satisfies GithubAuthorizationState),
    { expirationTtl: AUTH_STATE_TTL_SECONDS },
  );
  return htmlResponse(consentPage(id, csrf, client.clientName ?? 'MCP client'), csrfCookie(csrf));
}

async function continueToGithub(request: Request, env: OAuthEnv): Promise<Response> {
  const form = await request.formData();
  const id = textField(form, 'authorization_id');
  const csrf = textField(form, 'csrf_token');
  if (!id || !csrf || !csrfMatches(request, csrf)) {
    return new Response('Invalid consent request.', { status: 400, headers: { 'set-cookie': clearCsrfCookie() } });
  }

  const state = await readAuthorizationState(env.OAUTH_KV, authorizationKey(id));
  if (!state || !constantTimeEqual(csrf, state.session)) {
    return new Response('Authorization has expired.', { status: 400, headers: { 'set-cookie': clearCsrfCookie() } });
  }

  const githubState = randomToken();
  await env.OAUTH_KV.put(
    githubStateKey(githubState),
    JSON.stringify(state),
    { expirationTtl: AUTH_STATE_TTL_SECONDS },
  );
  await env.OAUTH_KV.delete(authorizationKey(id));

  const github = new URL('https://github.com/login/oauth/authorize');
  github.searchParams.set('client_id', requiredSecret(githubSecrets(env).GITHUB_CLIENT_ID, 'GITHUB_CLIENT_ID'));
  github.searchParams.set('redirect_uri', new URL('/oauth/github/callback', publicOrigin(env)).toString());
  github.searchParams.set('state', githubState);
  github.searchParams.set('scope', 'read:user');
  return Response.redirect(github.toString(), 302);
}

async function completeGithubAuthorization(request: Request, env: OAuthEnv): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const stateId = url.searchParams.get('state');
  if (!code || !stateId) return new Response('Invalid GitHub callback.', { status: 400 });

  // Delete before exchanging the GitHub code. KV supplies short-lived,
  // best-effort replay resistance; no GitHub credential is persisted.
  const state = await readAuthorizationState(env.OAUTH_KV, githubStateKey(stateId));
  await env.OAUTH_KV.delete(githubStateKey(stateId));
  if (!state || !csrfMatches(request, state.session)) {
    return new Response('GitHub authorization has expired.', { status: 400, headers: { 'set-cookie': clearCsrfCookie() } });
  }

  try {
    const githubToken = await exchangeGithubCode(code, env);
    const githubUser = await fetchGithubUser(githubToken);
    const login = normalizeGithubLogin(githubUser.login);
    if (!allowedGithubLogins(env.GITHUB_ALLOWED_LOGINS).has(login)) {
      return new Response('This GitHub account is not allowed.', { status: 403, headers: { 'set-cookie': clearCsrfCookie() } });
    }
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: state.request,
      userId: `github-${githubUser.id}`,
      scope: [READ_SCOPE],
      metadata: { githubLogin: login },
      props: { githubUserId: String(githubUser.id), githubLogin: login, scopes: [READ_SCOPE] } satisfies McpAuthProps,
    });
    return new Response(null, {
      status: 302,
      headers: { location: redirectTo, 'set-cookie': clearCsrfCookie() },
    });
  } catch {
    return new Response('GitHub authorization failed.', { status: 502, headers: { 'set-cookie': clearCsrfCookie() } });
  }
}

async function exchangeGithubCode(code: string, env: Env): Promise<string> {
  const body = new URLSearchParams({
    client_id: requiredSecret(githubSecrets(env).GITHUB_CLIENT_ID, 'GITHUB_CLIENT_ID'),
    client_secret: requiredSecret(githubSecrets(env).GITHUB_CLIENT_SECRET, 'GITHUB_CLIENT_SECRET'),
    code,
    redirect_uri: new URL('/oauth/github/callback', publicOrigin(env)).toString(),
  });
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const payload = await response.json().catch(() => null) as { access_token?: unknown } | null;
  if (!response.ok || !payload || typeof payload.access_token !== 'string') throw new Error('GitHub token exchange failed');
  return payload.access_token;
}

async function fetchGithubUser(accessToken: string): Promise<{ id: number; login: string }> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${accessToken}`,
      'user-agent': 'cloudflare-obsidian-livesync-mcp',
    },
  });
  const payload = await response.json().catch(() => null) as { id?: unknown; login?: unknown } | null;
  const id = payload?.id;
  const login = payload?.login;
  if (!response.ok || !payload || !Number.isSafeInteger(id) || typeof login !== 'string') {
    throw new Error('GitHub user lookup failed');
  }
  return { id: id as number, login };
}

function authorizationFailure(error: unknown): Response {
  if (!(error instanceof AuthorizationError)) return new Response('Authorization request is invalid.', { status: 400 });
  if (!error.redirectUri) return new Response(error.description, { status: 400 });
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set('error', error.code);
  redirect.searchParams.set('error_description', error.description);
  if (error.state) redirect.searchParams.set('state', error.state);
  if (error.issuer) redirect.searchParams.set('iss', error.issuer);
  return Response.redirect(redirect.toString(), 302);
}

function publicOrigin(env: Env): URL {
  const url = new URL(env.MCP_PUBLIC_BASE_URL);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('MCP_PUBLIC_BASE_URL must be an HTTPS origin without a path.');
  }
  return url;
}

function isCanonicalRequest(request: Request, env: Env): boolean {
  const canonical = publicOrigin(env);
  const actual = new URL(request.url);
  return actual.origin === canonical.origin && request.headers.get('host') === canonical.host;
}

function authorizationKey(id: string): string { return `obsidian-mcp:authorize:${id}`; }
function githubStateKey(id: string): string { return `obsidian-mcp:github:${id}`; }

async function readAuthorizationState(kv: KVNamespace, key: string): Promise<GithubAuthorizationState | undefined> {
  const token = key.slice(key.lastIndexOf(':') + 1);
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) return undefined;
  const value = await kv.get(key);
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as GithubAuthorizationState;
    if (!parsed || typeof parsed.session !== 'string' || !parsed.request || !Array.isArray(parsed.request.scope)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function textField(form: FormData, field: string): string | undefined {
  const value = form.get(field);
  return typeof value === 'string' ? value : undefined;
}

function csrfCookie(token: string): string {
  return `${CSRF_COOKIE}=${token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${AUTH_STATE_TTL_SECONDS}`;
}

function clearCsrfCookie(): string {
  return `${CSRF_COOKIE}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`;
}

function csrfMatches(request: Request, supplied: string): boolean {
  const cookie = request.headers.get('cookie')?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${CSRF_COOKIE}=`))?.slice(CSRF_COOKIE.length + 1);
  return typeof cookie === 'string' && constantTimeEqual(cookie, supplied);
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) difference |= leftBytes[index] ^ rightBytes[index];
  return difference === 0;
}

function requiredSecret(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function githubSecrets(env: Env): GithubSecrets {
  // Wrangler intentionally does not emit secret bindings in generated types.
  return env as unknown as GithubSecrets;
}

function consentPage(authorizationId: string, csrf: string, clientName: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Authorize vault access</title><body><main><h1>Authorize read-only vault access</h1><p>${escapeHtml(clientName)} requests access to list and read your configured vault.</p><form method="post" action="/authorize/consent"><input type="hidden" name="authorization_id" value="${escapeHtml(authorizationId)}"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button type="submit">Continue with GitHub</button></form></main></body></html>`;
}

function htmlResponse(body: string, setCookie: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'set-cookie': setCookie,
    },
  });
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

export default {
  fetch(request, env, ctx) {
    if (!isCanonicalRequest(request, env)) {
      return Promise.resolve(new Response('Invalid host.', { status: 400 }));
    }
    return providerFor(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
