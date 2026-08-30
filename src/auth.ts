import { couchError, json } from './http';
import type { AppEnv } from './types';

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

async function equalSecret(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  return difference === 0;
}

export async function authenticate(request: Request, env: AppEnv): Promise<Response | undefined> {
  if (!env.COUCHDB_PASSWORD) {
    return couchError(503, 'service_unavailable', 'COUCHDB_PASSWORD is not configured');
  }
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Basic ')) return unauthorized();
  try {
    const decoded = atob(header.slice(6));
    const separator = decoded.indexOf(':');
    const username = separator < 0 ? decoded : decoded.slice(0, separator);
    const password = separator < 0 ? '' : decoded.slice(separator + 1);
    if (
      !(await equalSecret(username, env.COUCHDB_USERNAME)) ||
      !(await equalSecret(password, env.COUCHDB_PASSWORD))
    ) {
      return unauthorized();
    }
  } catch {
    return unauthorized();
  }
}

function unauthorized(): Response {
  return json(
    { error: 'unauthorized', reason: 'Name or password is incorrect.' },
    {
      status: 401,
      headers: { 'www-authenticate': 'Basic realm="couchdb"' },
    }
  );
}
