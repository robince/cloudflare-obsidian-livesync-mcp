import type { CouchErrorBody } from './types';

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  headers.set('cache-control', 'no-store');
  return Response.json(data, { ...init, headers });
}

export function couchError(status: number, error: string, reason: string): Response {
  return json({ error, reason } satisfies CouchErrorBody, { status });
}

export function pouchError(error: unknown): Response {
  if (typeof error === 'object' && error !== null) {
    const value = error as { status?: unknown; name?: unknown; message?: unknown; reason?: unknown };
    const status = typeof value.status === 'number' ? value.status : 500;
    return couchError(
      status,
      typeof value.name === 'string' ? value.name : status === 500 ? 'internal_server_error' : 'unknown_error',
      typeof value.reason === 'string'
        ? value.reason
        : typeof value.message === 'string'
          ? value.message
          : 'unknown error'
    );
  }
  return couchError(500, 'internal_server_error', String(error));
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400, name: 'bad_request' });
  }
}

export function booleanParam(url: URL, key: string): boolean | undefined {
  if (!url.searchParams.has(key)) return undefined;
  return url.searchParams.get(key) === 'true';
}

export function jsonParam<T>(url: URL, key: string): T | undefined {
  const value = url.searchParams.get(key);
  return value === null ? undefined : (JSON.parse(value) as T);
}
