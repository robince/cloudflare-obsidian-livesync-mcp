import { SELF, reset } from 'cloudflare:test';
// The checked-out PouchDB monorepo intentionally ships its generated ESM
// bundles without TypeScript declarations.
// @ts-expect-error local PouchDB checkout build
import CurrentPouchDB from '../../pouchdb/packages/node_modules/pouchdb-core/lib/index.es.js';
// @ts-expect-error local PouchDB checkout build
import CurrentHttpPouch from '../../pouchdb/packages/node_modules/pouchdb-adapter-http/lib/index.es.js';
// @ts-expect-error local PouchDB checkout build
import CurrentReplication from '../../pouchdb/packages/node_modules/pouchdb-replication/lib/index.es.js';
import { afterEach, describe, expect, it } from 'vitest';

CurrentPouchDB.plugin(CurrentHttpPouch).plugin(CurrentReplication);

afterEach(async () => {
  await reset();
});

function currentRemote(name: string) {
  return new CurrentPouchDB(`https://current-pouch.test/${name}`, {
    adapter: 'http',
    auth: { username: 'admin', password: 'test-password' },
    fetch(input: RequestInfo | URL, init?: RequestInit) {
      return SELF.fetch(new Request(input, init));
    },
  });
}

describe('current ../pouchdb checkout compatibility', () => {
  it('performs filtered changes and replication through the CouchDB endpoint', async () => {
    const source = currentRemote('current-source');
    const target = currentRemote('current-target');
    await source.bulkDocs([
      { _id: 'note', type: 'plain', data: 'from-current-pouchdb' },
      { _id: 'h:leaf', type: 'leaf', data: 'chunk' },
    ]);

    const filtered = await source.changes({
      since: 0,
      include_docs: true,
      selector: { type: { $ne: 'leaf' } },
    });
    expect(filtered.results.map((change: { id: string }) => change.id)).toEqual(['note']);

    const replication = await CurrentPouchDB.replicate(source, target);
    expect(replication).toMatchObject({ ok: true, docs_written: 2 });
    expect(await target.get('note')).toMatchObject({ data: 'from-current-pouchdb' });
    expect(await target.get('h:leaf')).toMatchObject({ data: 'chunk' });
  });
});
