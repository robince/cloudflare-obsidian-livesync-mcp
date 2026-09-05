import { expect, it } from 'vitest';
import { streamChanges } from '../src/changes-feed';
import { operationFor } from '../src/diagnostics';

it('reports changes only after stream consumption without copying contents', async () => {
  async function* rows() { yield { id: 'private.md', data: 'secret' }; return { last_seq: 1, pending: 0 }; }
  const iterator = rows();
  const events: unknown[] = [];
  const response = streamChanges(iterator, await iterator.next(), false, (...args) => events.push(args));
  expect(await response.json()).toMatchObject({ results: [{ id: 'private.md' }] });
  expect(events).toEqual([['success', 1]]);
});
it('distinguishes stream cancellation and failure from successful completion', async () => {
  async function* rows() { yield { id: 'private.md' }; yield { id: 'other.md' }; return { last_seq: 2, pending: 0 }; }
  const iterator = rows(), events: unknown[] = [];
  const response = streamChanges(iterator, await iterator.next(), false, (...args) => events.push(args));
  await response.body!.cancel();
  expect(events[0]).toEqual(['cancelled', expect.any(Number)]);
  async function* broken() { yield { id: 'private.md' }; throw new Error('secret'); return { last_seq: 0, pending: 0 }; }
  const failing = broken(), failures: unknown[] = [];
  const failed = streamChanges(failing, await failing.next(), false, (...args) => failures.push(args));
  await expect(failed.text()).rejects.toThrow();
  expect(failures).toEqual([['error', 1]]);
});
it('route classification never returns identifiers or inherited properties', () => {
  expect(operationFor('/private.md','GET')).toBe('document_read');
  expect(operationFor('/constructor','GET')).toBe('document_read');
  expect(operationFor('/_changes','GET')).toBe('changes');
});
