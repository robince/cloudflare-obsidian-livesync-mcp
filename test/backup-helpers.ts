import { runInDurableObject } from 'cloudflare:test';
import { expect } from 'vitest';
import type { PouchDatabase } from '../src/pouch-database';

export async function expectCounts(stub: DurableObjectStub<PouchDatabase>, name: string) {
  const result = await runInDurableObject(stub, async (db: PouchDatabase) => {
    const oracle = db['ctx'].storage.sql.exec<{ num: number }>(`SELECT COUNT(d.id) AS num
      FROM "document-store" d JOIN "by-sequence" b ON b.seq = d.winningseq WHERE b.deleted = 0`).one().num;
    const adapter = db['database'](name);
    return { oracle, info: (await adapter.info()).doc_count, rows: (await adapter.allDocs()).total_rows,
      meta: db['ctx'].storage.sql.exec('SELECT db_version, doc_count FROM "metadata-store"').one() };
  });
  expect(result.info).toBe(result.oracle);
  expect(result.rows).toBe(result.oracle);
  expect(result.meta).toEqual({ db_version: 2, doc_count: result.oracle });
  return result.oracle;
}
