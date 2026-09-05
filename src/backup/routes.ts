import { json, couchError, pouchError } from '../http';
import { DATABASE_NAME, fail, boundedBytes } from './format';
import { listBackups, readManifest, directory, verifyBackup } from './storage';

export async function backupRoute(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean).slice(1);
    const database = url.searchParams.get('database') ?? env.BACKUP_DATABASE;
    if (!DATABASE_NAME.test(database)) fail('Invalid database name');
    const stub = env.POUCH_DATABASES.getByName(database);
    if (parts.length === 0 && request.method === 'GET') return json(await listBackups(env.BACKUP_BUCKET, database));
    if (parts.length === 0 && request.method === 'POST') return json(await stub.createBackup(database));
    if (parts[0] === 'status' && parts.length === 1 && request.method === 'GET') return json(await stub.backupStatus());
    if (parts[0] === 'restore' && parts.length === 1 && request.method === 'POST') {
      if (Number(request.headers.get('content-length')) > 4096) fail('Restore request too large');
      const body = new TextDecoder().decode(await boundedBytes(request.body, 4096));
      if (body.length > 4096) fail('Restore request too large');
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { fail('Invalid restore JSON'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('Restore request must be an object');
      const { target, id, restart } = parsed as Record<string, unknown>;
      if (typeof target !== 'string' || !DATABASE_NAME.test(target) || typeof id !== 'string' || (restart !== undefined && typeof restart !== 'boolean')) fail('Invalid restore request');
      return json(await env.POUCH_DATABASES.getByName(target).restoreBackup(target, database, id, restart === true));
    }
    if (parts.length === 2 && request.method === 'GET') {
      const manifest = await readManifest(env.BACKUP_BUCKET, database, parts[0]);
      if (parts[1] === 'manifest.json') return json(manifest);
      const part = manifest.parts.find(p => p.file === parts[1]);
      if (!part) fail('Backup file not found', 404);
      const object = await env.BACKUP_BUCKET.get(`${directory(database, manifest.id)}${part.file}`);
      if (!object) fail('Backup part missing', 404);
      return new Response(object.body, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
    }
    if (parts.length === 2 && parts[1] === 'verify' && request.method === 'POST') {
      const manifest = await readManifest(env.BACKUP_BUCKET, database, parts[0]);
      await verifyBackup(env.BACKUP_BUCKET, manifest); return json({ ok: true });
    }
    return couchError(404, 'not_found', 'Unknown backup operation');
  } catch (error) {
    const response = pouchError(error);
    if (response.status === 503) response.headers.set('retry-after', '60');
    return response;
  }
}
