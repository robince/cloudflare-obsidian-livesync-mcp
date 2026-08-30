export const IN_PROCESS_COUCH_ORIGIN = 'https://livesync.invalid';

export type InProcessCouchDispatch = (request: Request) => Promise<Response>;

/**
 * Construct the only transport Commonlib may use inside a PouchDatabase object.
 *
 * The database identity is captured by the closure. Callers cannot select a
 * different Durable Object by changing either the URL or request headers.
 */
export function createInProcessCouchFetch(
  databaseName: string,
  dispatch: InProcessCouchDispatch
): typeof globalThis.fetch {
  if (!databaseName) throw new Error('database identity is required');
  const databasePath = `/${encodeURIComponent(databaseName)}`;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const incomingUrl = requestUrl(input);
    if (incomingUrl.origin !== IN_PROCESS_COUCH_ORIGIN) {
      throw new TypeError('in-process CouchDB transport rejected a foreign origin');
    }
    if (incomingUrl.username || incomingUrl.password) {
      throw new TypeError('in-process CouchDB transport rejected URL credentials');
    }
    if (incomingUrl.pathname !== databasePath && !incomingUrl.pathname.startsWith(`${databasePath}/`)) {
      throw new TypeError('in-process CouchDB transport rejected a database identity mismatch');
    }

    const incoming = new Request(sanitizedRequestInfo(input, incomingUrl), init);
    const forwardedUrl = new URL(incomingUrl);
    forwardedUrl.pathname = incomingUrl.pathname.slice(databasePath.length) || '/';
    const headers = new Headers(incoming.headers);
    headers.set('x-pouchdb-database', databaseName);
    headers.delete('authorization');

    const forwarded = new Request(forwardedUrl, {
      method: incoming.method,
      headers,
      body: incoming.body,
      // Workers deliberately does not implement Request.redirect = "error".
      // Manual mode plus the response-status check below provides the same
      // fail-closed behaviour without following a Location header.
      redirect: 'manual',
      signal: incoming.signal,
    });
    const response = await dispatch(forwarded);
    if (response.status >= 300 && response.status < 400) {
      throw new TypeError('in-process CouchDB transport rejected a redirect');
    }
    return response;
  };
}

function requestUrl(input: RequestInfo | URL): URL {
  if (typeof input === 'string') return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

/** Drop embedded credentials before constructing Request, which may reject them. */
function sanitizedRequestInfo(input: RequestInfo | URL, url: URL): RequestInfo | URL {
  if (typeof input === 'string' || input instanceof URL) {
    url.username = '';
    url.password = '';
    return url;
  }
  return input;
}
