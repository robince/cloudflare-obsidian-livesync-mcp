import { vaultErrorCodeSchema } from '@cloudflare-obsidian-livesync/contracts';

type ToolResult = { isError?: boolean; structuredContent?: object };

/** Log only fixed metadata: never arguments, note text, paths or error messages. */
export function observeTool<A extends unknown[], R extends ToolResult>(tool: string, handler: (...args: A) => Promise<R>) {
  const known = ['vault_status','list_files','search_files','read_file','read_files','get_file_outline','read_frontmatter','list_attachments','read_attachment','create_file','edit_file','append_file','patch_file','patch_frontmatter','delete_file'];
  tool = known.includes(tool) ? tool : 'unknown';
  return async (...args: A): Promise<R> => {
    const requestId = crypto.randomUUID();
    const started = performance.now();
    console.log({ schemaVersion: 1, event: 'mcp_tool_start', requestId, tool });
    try {
      const result = await handler(...args);
      const data = result.structuredContent as {
        error?: { code?: unknown };
        files?: Array<{ result?: { ok?: boolean; omitted?: boolean; error?: { code?: unknown } } }>;
      } | undefined;
      const items = data?.files ?? [];
      const failedItems = items.filter((item) => item.result?.ok === false || item.result?.omitted).length;
      const errorCodes = [...new Set([data?.error?.code, ...items.map((item) => item.result?.error?.code)]
        .flatMap((code) => { const parsed = vaultErrorCodeSchema.safeParse(code); return parsed.success ? [parsed.data] : []; }))];
      console.log({ schemaVersion: 1, event: 'mcp_tool_end', requestId, tool, durationMs: Math.round(performance.now() - started),
        outcome: result.isError ? 'error' : failedItems ? 'partial' : 'success', errorCodes,
        ...(items.length ? { itemCount: items.length, failedItems } : {}),
      });
      return result;
    } catch (error) {
      console.log({ schemaVersion: 1, event: 'mcp_tool_end', requestId, tool, durationMs: Math.round(performance.now() - started), outcome: 'exception' });
      throw error;
    }
  };
}
