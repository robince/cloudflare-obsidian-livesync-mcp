import type PouchDB from 'pouchdb-core';
import type { JsonObject } from './types';

function unsafe(): never {
  throw Object.assign(new Error('Chunk cleanup safety could not be established. Complete replication, pause writers, and repair unreadable revisions before retrying maintenance.'),
    { status: 503, name: 'maintenance_unavailable' });
}

/** Includes deleted winners and all still-readable ancestors, not just allDocs winners. */
export async function chunkReferences(db: PouchDB.Database<JsonObject>, sql: SqlStorage): Promise<Map<string, number>> {
  const references = new Map<string, number>();
  const deadline = Date.now() + 3_000;
  let examined = 0;
  let after = '';
  while (true) {
    const page = sql.exec<{ id: string; json: string }>('SELECT id,json FROM "document-store" WHERE id>? ORDER BY id LIMIT 16', after).toArray();
    if (!page.length) return references;
    for (const row of page) {
      if (++examined > 20_000 || Date.now() > deadline) unsafe();
      after = row.id;
      if (row.id.startsWith('h:')) { if (!references.has(row.id)) references.set(row.id, 0); continue; }
      if (row.id.startsWith('_design/')) continue;
      let metadata: { rev_tree?: Array<{ pos: number; ids: unknown }> };
      try { metadata = JSON.parse(row.json); } catch { unsafe(); }
      if (!metadata || typeof metadata !== 'object' || !Array.isArray(metadata.rev_tree)) unsafe();
      const stack = metadata.rev_tree.map((root) => {
        if (!root || !Number.isSafeInteger(root.pos) || root.pos < 1) unsafe();
        return { pos: root.pos, node: root.ids };
      });
      while (stack.length) {
        if (++examined > 20_000 || Date.now() > deadline) unsafe();
        const { pos, node } = stack.pop()!;
        if (!Array.isArray(node) || node.length !== 3 || !Array.isArray(node[2])
          || typeof node[0] !== 'string' || !node[0]
          || !node[1] || typeof node[1] !== 'object' || Array.isArray(node[1])) unsafe();
        const [hash, options, children] = node as [string, { status?: string }, unknown[]];
        if (options.status === 'available') {
          let doc: JsonObject;
          try { doc = await db.get(row.id, { rev: `${pos}-${hash}` }) as JsonObject; } catch { unsafe(); }
          if (doc.children !== undefined) {
            if (!Array.isArray(doc.children) || !doc.children.every((id) => typeof id === 'string')) unsafe();
            for (const id of doc.children as string[]) references.set(id, (references.get(id) ?? 0) + 1);
          } else if (typeof doc.path === 'string' && doc._deleted !== true) unsafe();
        } else if (!children.length) unsafe();
        for (const child of children) stack.push({ pos: pos + 1, node: child });
      }
    }
  }
}
