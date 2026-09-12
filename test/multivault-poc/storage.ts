import PouchDB from 'pouchdb-core';
import adapter from '@robince/pouchdb-adapter-cloudflare-do';

PouchDB.plugin(adapter);

const names = new Set([
  'document-store', 'by-sequence', 'attach-store', 'local-store',
  'metadata-store', 'attach-seq-store', 'by-seq-deleted-idx',
  'by-seq-doc-id-rev', 'doc-winningseq-idx', 'attach-seq-seq-idx',
  'attach-seq-digest-idx', 'cloudflare_pouchdb_meta',
  'livesync_search_meta', 'livesync_search_documents', 'livesync_search_fts',
]);

// EXPERIMENT ONLY: finite token translation for the pinned adapter's SQL.
// Includes schema-name literals in sqlite_master/sqlite_sequence queries.
// Never rewrite bound values. Production should generate scoped identifiers
// in the adapter itself, not translate arbitrary SQL at runtime.
export function translate(sql: string, namespace: string): string {
  if (!/^[a-z][a-z0-9]*$/.test(namespace)) throw new Error('Invalid test namespace');
  return sql.replace(/'([^']|'')*'|"([^"]|"")*"|[a-zA-Z_][a-zA-Z_0-9]*/g, token => {
    const quoted = token.startsWith("'") || token.startsWith('"');
    const name = quoted ? token.slice(1, -1) : token;
    if (!names.has(name)) return token;
    return quoted ? `${token[0]}${namespace}_${name}${token[0]}` : `${namespace}_${name}`;
  });
}

export function scopedStorage(storage: DurableObjectStorage, namespace: string): DurableObjectStorage {
  const sql = new Proxy(storage.sql, {
    get(target, key) {
      if (key === 'exec') return (query: string, ...bindings: SqlStorageValue[]) => {
        // Backup format stores logical sequence-table names. Special-case the
        // exact pinned exporter/importer statements; ordinary values stay intact.
        if (query === 'INSERT INTO "sqlite_sequence" ("name","seq") VALUES (?,?)') {
          if (bindings[0] !== 'by-sequence') throw new Error('Unexpected archive sequence');
          bindings = [`${namespace}_by-sequence`, bindings[1]];
        }
        let translated = translate(query, namespace);
        if (query.startsWith('SELECT "name","seq" FROM "sqlite_sequence"')) {
          translated = translated.replace('SELECT "name",', "SELECT 'by-sequence' AS name,");
        }
        return target.exec(translated, ...bindings);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return new Proxy(storage, {
    get(target, key) {
      if (key === 'sql') return sql;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function open(storage: DurableObjectStorage, name: string) {
  return new PouchDB<{ value?: string }>(name, {
    adapter: 'sqlite', sqliteImplementation: 'cloudflare-do', durableObjectStorage: storage,
  } as PouchDB.Configuration.DatabaseConfiguration);
}

// Test-only dependency injection: ordinary application instances execute inside
// one real host DO. These are not additional Cloudflare object instances.
export function scopedState(state: DurableObjectState, namespace: string): DurableObjectState {
  const storage = scopedStorage(state.storage, namespace);
  return new Proxy(state, {
    get(target, key) {
      if (key === 'storage') return storage;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
