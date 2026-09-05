/** Fixed metadata only. Callers must never pass user text, identifiers or errors. */
type Diagnostic = {
  event: 'operation_end' | 'changes_wait' | 'changes_end' | 'backup_end' | 'search_error' | 'request_error';
  operation: string;
  outcome: 'success' | 'error' | 'cancelled' | 'exception';
  requestId?: string;
  status?: number;
  durationMs?: number;
  waitMs?: number;
  returnedChanges?: number;
  concurrentWaits?: number;
  empty?: boolean;
  longpoll?: boolean;
  reason?: 'change' | 'timeout' | 'cancelled' | 'error' | 'immediate';
  bytes?: number;
  pauseMs?: number;
};
export function diagnostic(value: Diagnostic): void {
  console.log({ schemaVersion: 1, ...value });
}
export function operationFor(path: string, method: string): string {
  const part = path.split('/').filter(Boolean)[0];
  const operations: Record<string, string> = { _changes:'changes', _bulk_docs:'bulk_docs', _bulk_get:'bulk_get', _all_docs:'all_docs', _revs_diff:'revs_diff', _find:'find', _index:'index', _purge:'purge', _compact:'compact', _backup:'backup' };
  if (!part) return 'database';
  return (Object.hasOwn(operations, part) ? operations[part] : undefined) ?? (part.startsWith('_') ? 'request' : ['GET','HEAD'].includes(method) ? 'document_read' : 'document_write');
}
