import { expect, it, vi } from 'vitest';
import { observeTool } from '../src/tool-logging';

it('logs paired timing and safe outcomes without arguments, content, paths or error messages', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const result = { structuredContent: { files: [{ path: 'private.md', result: { ok: false, error: { code: 'not_found', message: 'private message' } } }] } };
    expect(await observeTool('read_files', async (_input: string) => result)('private input')).toBe(result);
    const [start, end] = log.mock.calls.map(([entry]) => entry);
    expect(start).toMatchObject({ event: 'mcp_tool_start', tool: 'read_files' });
    expect(end).toMatchObject({ event: 'mcp_tool_end', requestId: start.requestId, durationMs: expect.any(Number), outcome: 'partial', itemCount: 1, failedItems: 1, errorCodes: ['not_found'] });
    await observeTool('delete_file', async () => ({ isError: true }))();
    expect(log.mock.lastCall?.[0]).toMatchObject({ outcome: 'error' });
    await expect(observeTool('read_file', async () => { throw new Error('private exception'); })()).rejects.toThrow('private exception');
    expect(log.mock.lastCall?.[0]).toMatchObject({ outcome: 'exception' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('private');
  } finally { log.mockRestore(); }
});
