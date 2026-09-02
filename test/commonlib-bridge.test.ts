import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import fixture from './fixtures/livesync-1.0.21.json';
import { createInProcessCouchFetch, IN_PROCESS_COUCH_ORIGIN } from '../src/livesync-vault/in-process-couch-fetch';
import { inspectVaultProfile, MILESTONE_DOCUMENT_ID } from '../src/livesync-vault/profile';
import type { JsonObject } from '../src/types';

function databaseName(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replaceAll('-', '')}`;
}

function withoutRevision(document: JsonObject): JsonObject {
  const copy = structuredClone(document);
  delete copy._rev;
  delete copy._revisions;
  delete copy._revs_info;
  delete copy._conflicts;
  return copy;
}

describe('fixed-identity Commonlib CouchDB transport', () => {
  it('strips only its captured database prefix and overwrites caller identity', async () => {
    const dispatched: Request[] = [];
    const transport = createInProcessCouchFetch('fixed-db', async (request) => {
      dispatched.push(request);
      return Response.json({ ok: true });
    });

    const response = await transport(`${IN_PROCESS_COUCH_ORIGIN}/fixed-db/_all_docs?include_docs=true`, {
      headers: {
        authorization: 'Basic should-not-survive',
        'x-pouchdb-database': 'attacker-db',
      },
    });

    expect(response.status).toBe(200);
    expect(dispatched).toHaveLength(1);
    expect(new URL(dispatched[0].url).pathname).toBe('/_all_docs');
    expect(dispatched[0].headers.get('x-pouchdb-database')).toBe('fixed-db');
    expect(dispatched[0].headers.has('authorization')).toBe(false);
  });

  it('rejects origin, database, prefix-confusion, credentials, and redirects', async () => {
    const dispatch = vi.fn(async () => Response.json({ ok: true }));
    const transport = createInProcessCouchFetch('fixed-db', dispatch);

    await expect(transport('https://example.com/fixed-db')).rejects.toThrow('foreign origin');
    await expect(transport('https://user:pass@livesync.invalid/fixed-db')).rejects.toThrow('credentials');
    await expect(transport(`${IN_PROCESS_COUCH_ORIGIN}/other-db`)).rejects.toThrow('identity mismatch');
    await expect(transport(`${IN_PROCESS_COUCH_ORIGIN}/fixed-db-escape/_all_docs`)).rejects.toThrow('identity mismatch');
    expect(dispatch).not.toHaveBeenCalled();

    const redirecting = createInProcessCouchFetch('fixed-db', async () =>
      new Response(null, { status: 302, headers: { location: 'https://example.com/' } })
    );
    await expect(redirecting(`${IN_PROCESS_COUCH_ORIGIN}/fixed-db`)).rejects.toThrow('redirect');
  });
});

describe('Self-hosted LiveSync 1.0.21 compatibility in workerd', () => {
  it('reads the current-client fixture byte-for-byte through Commonlib', async () => {
    expect(fixture.producer).toEqual({
      release: '1.0.21',
      commit: 'f5f7aab11f03f62c6946d2fa296c50bb5df5b2a4',
      commonlib: '0.1.19',
    });
    const name = databaseName('livesync-1021');
    const stub = env.POUCH_DATABASES.getByName(name);
    await stub.ensureDatabase(name);
    for (const document of fixture.documents) {
      await stub.putDocument(name, withoutRevision(document as JsonObject));
    }
    for (const document of Object.values(fixture.localDocuments)) {
      await stub.putDocument(name, withoutRevision(document as JsonObject));
    }

    for (const [path, content] of Object.entries(fixture.files)) {
      await expect(stub.readVaultFile({ path })).resolves.toMatchObject({
        ok: true,
        data: { path, content },
      });
    }
  });
});

describe('read profile checks', () => {
  const milestone = (preferred: Record<string, unknown>) => ({
    _id: MILESTONE_DOCUMENT_ID,
    _rev: '0-1',
    tweak_values: { PREFERRED: preferred },
  });

  it('accepts the supported current-client profile', () => {
    expect(inspectVaultProfile(milestone({
      encrypt: false,
      usePathObfuscation: false,
      enableCompression: false,
      handleFilenameCaseSensitive: false,
      hashAlg: 'xxhash64',
    }), undefined)).toMatchObject({ supported: true });
  });

  it.each<[Record<string, unknown>, string]>([
    [{ encrypt: true, usePathObfuscation: false, hashAlg: 'xxhash64' }, 'encryption_unsupported'],
    [{ encrypt: false, usePathObfuscation: true, hashAlg: 'xxhash64' }, 'path_obfuscation_unsupported'],
    [{ encrypt: false, usePathObfuscation: false, hashAlg: 'mixed-purejs' }, 'hash_algorithm_unsupported'],
  ])('rejects unsupported content addressing', (preferred, reason) => {
    expect(inspectVaultProfile(milestone(preferred), undefined)).toMatchObject({
      supported: false,
      reasons: expect.arrayContaining([reason]),
    });
  });
});
