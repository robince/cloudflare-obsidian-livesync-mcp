import { diagnostic } from './diagnostics';
import { backupRoute } from './backup/routes';
import { authenticate } from './auth';
import { couchError, json, readJson } from './http';
import { PouchDatabase } from './pouch-database';
import type { AppEnv } from './types';

export { PouchDatabase };

const DATABASE_NAME = /^[a-z][a-z0-9_$()+-]*$/;

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    if (env.BACKUP_ENABLED !== 'true') return;
    if (!DATABASE_NAME.test(env.BACKUP_DATABASE)) throw new Error('Invalid BACKUP_DATABASE');
    await env.POUCH_DATABASES.getByName(env.BACKUP_DATABASE).createBackup(env.BACKUP_DATABASE, true);
  },
  async fetch(request: Request, baseEnv: Env): Promise<Response> {
    const env = baseEnv as AppEnv;
    const origin = request.headers.get('origin');
    if (request.method === 'OPTIONS') return corsPreflight(env, origin);

    let response: Response;
    try {
      const url = new URL(request.url);
      if (url.pathname === '/_up') {
        response = json({ status: 'ok' });
      } else {
        const authFailure = await authenticate(request, env);
        if (authFailure) diagnostic({ event: 'operation_end', operation: 'auth', outcome: 'error', status: authFailure.status });
        response = authFailure ?? (await routeAuthenticated(request, url, env));
      }
    } catch (error) {
      diagnostic({ event: 'request_error', operation: 'request', outcome: 'exception', status: 500 });
      response = couchError(500, 'internal_server_error', 'Internal server error.');
    }
    return withCors(response, env, origin);
  },
} satisfies ExportedHandler<Env>;

async function routeAuthenticated(request: Request, url: URL, env: AppEnv): Promise<Response> {
  if (url.pathname === '/_backup' || url.pathname.startsWith('/_backup/')) return backupRoute(request, env);
  if (url.pathname === '/') {
    return json({
      couchdb: 'Welcome',
      version: '3.3.3-cloudflare-pouchdb',
      git_sha: 'local',
      // PouchDB uses this value when deriving replication checkpoint IDs. The
      // origin prevents two deployments with the same database name sharing a
      // false checkpoint identity.
      uuid: url.origin,
      features: ['readyz'],
      vendor: { name: 'cloudflare-pouchdb' },
    }, { headers: { server: 'CouchDB/3.3.3' } });
  }
  if (url.pathname === '/_session') {
    return json({ ok: true, userCtx: { name: env.COUCHDB_USERNAME, roles: ['_admin'] }, info: { authenticated: 'default' } });
  }
  if (url.pathname === '/_cluster_setup' && request.method === 'POST') {
    return json({ ok: true });
  }
  if (url.pathname.startsWith('/_node/') && url.pathname.includes('/_config')) {
    return configurationRoute(request, url, env);
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length === 0 || parts[0].startsWith('_')) {
    return couchError(404, 'not_found', 'missing');
  }
  const databaseName = decodeURIComponent(parts[0]);
  if (!DATABASE_NAME.test(databaseName)) {
    return couchError(400, 'illegal_database_name', 'Name must begin with a lowercase letter.');
  }

  const stub = env.POUCH_DATABASES.getByName(databaseName);
  const forwardedUrl = new URL(request.url);
  forwardedUrl.pathname = '/' + parts.slice(1).join('/');
  const headers = new Headers(request.headers);
  headers.set('x-pouchdb-database', databaseName);
  headers.delete('authorization');
  return stub.fetch(new Request(forwardedUrl, { method: request.method, headers, body: request.body }));
}

async function configurationRoute(request: Request, url: URL, env: AppEnv): Promise<Response> {
  const marker = '/_config';
  const suffix = url.pathname.slice(url.pathname.indexOf(marker) + marker.length).replace(/^\//, '');
  const origins = env.CORS_ORIGINS;
  const config: Record<string, Record<string, string>> = {
    admins: { [env.COUCHDB_USERNAME]: '-hashed-' },
    chttpd: { require_valid_user: 'true', enable_cors: 'true', max_http_request_size: '4294967296' },
    chttpd_auth: { require_valid_user: 'true' },
    httpd: { 'WWW-Authenticate': 'Basic realm="couchdb"', enable_cors: 'true' },
    couchdb: { max_document_size: '50000000' },
    cors: { credentials: 'true', origins },
  };
  if (!suffix) return json(config, { headers: { server: 'CouchDB/3.3.3' } });
  const [section, ...keyParts] = suffix.split('/').map(decodeURIComponent);
  const key = keyParts.join('/');
  if (request.method === 'GET') {
    const value = config[section]?.[key];
    return value === undefined ? couchError(404, 'not_found', 'unknown_config_value') : json(value);
  }
  if (request.method === 'PUT') {
    await readJson<unknown>(request);
    return json(config[section]?.[key] ?? null);
  }
  return couchError(405, 'method_not_allowed', 'GET or PUT required');
}

function allowedOrigin(env: AppEnv, origin: string | null): string | undefined {
  if (!origin) return undefined;
  const origins = env.CORS_ORIGINS.split(',').map((value) => value.trim());
  return origins.includes('*') || origins.includes(origin) ? origin : undefined;
}

function withCors(response: Response, env: AppEnv, origin: string | null): Response {
  const allowed = allowedOrigin(env, origin);
  if (!allowed) return response;
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', allowed);
  headers.set('access-control-allow-credentials', 'true');
  headers.append('vary', 'Origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function corsPreflight(env: AppEnv, origin: string | null): Response {
  const allowed = allowedOrigin(env, origin);
  if (!allowed) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': allowed,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET, HEAD, PUT, POST, DELETE, OPTIONS',
      'access-control-allow-headers': 'accept, authorization, content-type, origin',
      'access-control-max-age': '86400',
      vary: 'Origin',
    },
  });
}
