import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';

import { createVaultMcpServer } from '../apps/cloudflare-obsidian-mcp/src/vault-tools';
import type { VaultRpc } from '../apps/cloudflare-obsidian-mcp/src/vault-rpc';
import fixture from './fixtures/livesync-1.0.21.json';
import type { JsonObject } from '../src/types';
import { conflictVault } from './conflict-fixtures';

const closeables: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((closeable) => closeable.close()));
});

function withoutRevision(document: JsonObject): JsonObject {
  const copy = structuredClone(document);
  delete copy._rev;
  delete copy._revisions;
  delete copy._revs_info;
  delete copy._conflicts;
  return copy;
}

describe('MCP to storage Durable Object integration', () => {
  it('preserves structured conflicts through a real MCP client and prevents read-only reconciliation', async () => {
    const { stub, path, tree } = await conflictVault();
    const before = await tree();
    for (const writable of [false, true]) {
      const server = createVaultMcpServer(stub as unknown as VaultRpc, {
        writesEnabled: true, canRead: () => true, canWrite: () => writable,
      });
      const client = new Client({ name: 'conflict-client', version: '1' });
      const [a, b] = InMemoryTransport.createLinkedPair();
      closeables.push(client, server);
      await Promise.all([client.connect(a), server.connect(b)]);
      expect(await client.callTool({ name: 'read_file', arguments: { path } })).toMatchObject({
        isError: true, structuredContent: { error: {
          code: 'livesync_conflict', path, unresolvedVersions: 2, resolution: 'obsidian',
        } },
      });
      expect(await client.callTool({ name: 'search_files', arguments: { query: 'base' } })).toMatchObject({
        structuredContent: {
          results: [expect.objectContaining({ path, unresolvedVersions: 2 })],
        },
      });
      const write = await client.callTool({ name: 'append_file', arguments: { path, expectedRevision: '2-b', content: 'NEVER' } });
      expect(write.isError).toBe(true);
      if (!writable) expect(await tree()).toEqual(before);
      else expect(write).toMatchObject({ structuredContent: { error: { code: 'conflict_reconciled', path } } });
    }
  });
  it('exercises the complete tool surface through real RPC serialization', async () => {
    const name = `mcp-integration-${crypto.randomUUID().replaceAll('-', '')}`;
    const stub = env.POUCH_DATABASES.getByName(name);
    await stub.ensureDatabase(name);
    for (const document of fixture.documents) {
      await stub.putDocument(name, withoutRevision(document as JsonObject));
    }
    for (const document of Object.values(fixture.localDocuments)) {
      await stub.putDocument(name, withoutRevision(document as JsonObject));
    }
    await stub.putDocument(name, { _id: 'h:mcp-attachment', type: 'leaf', data: 'AQID' });
    await stub.putDocument(name, {
      _id: 'assets/mcp.png', path: 'assets/mcp.png', type: 'newnote', datatype: 'newnote',
      children: ['h:mcp-attachment'], ctime: 1, mtime: 2, size: 3, eden: {},
    });

    const server = createVaultMcpServer(stub as unknown as VaultRpc, {
      writesEnabled: true,
      canRead: () => true,
      canWrite: () => true,
    });
    const client = new Client({ name: 'integration-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'vault_status', 'list_files', 'search_files', 'read_file', 'get_file_outline', 'read_frontmatter', 'list_attachments', 'read_attachment',
      'create_file', 'edit_file', 'append_file', 'patch_file', 'patch_frontmatter', 'delete_file',
    ]);
    const patchFrontmatter = tools.tools.find((tool) => tool.name === 'patch_frontmatter');
    expect(patchFrontmatter?.inputSchema.properties?.updates).toMatchObject({
      type: 'object',
      additionalProperties: expect.objectContaining({ $ref: expect.any(String) }),
    });
    const readFrontmatter = tools.tools.find((tool) => tool.name === 'read_frontmatter');
    const readOutputProperties = readFrontmatter?.outputSchema?.properties as Record<string, unknown> | undefined;
    expect(readOutputProperties?.frontmatter).toMatchObject({
      type: 'object',
      additionalProperties: expect.objectContaining({ $ref: expect.any(String) }),
    });
    expect(tools.tools.find((tool) => tool.name === 'read_file')?.description).toContain('escaped \\n');
    expect(tools.tools.find((tool) => tool.name === 'append_file')?.description).toContain('typing \\n');
    await expect(client.callTool({ name: 'vault_status', arguments: {} })).resolves.toMatchObject({
      structuredContent: { compatible: true },
    });
    await expect(client.callTool({ name: 'list_files', arguments: { prefix: 'notes/' } })).resolves.toMatchObject({
      structuredContent: {
        files: expect.arrayContaining([
          expect.objectContaining({ path: 'notes/unicode-雪.md' }),
        ]),
      },
    });
    await expect(client.callTool({ name: 'search_files', arguments: { query: 'naive', pathPrefix: 'notes/' } })).resolves.toMatchObject({
      structuredContent: {
        results: expect.arrayContaining([expect.objectContaining({ path: 'notes/unicode-雪.md' })]),
        incomplete: false,
      },
    });
    await expect(client.callTool({ name: 'read_file', arguments: { path: 'notes/unicode-雪.md' } })).resolves.toMatchObject({
      structuredContent: { content: fixture.files['notes/unicode-雪.md'] },
    });
    const readWithText = await client.callTool({ name: 'read_file', arguments: { path: 'notes/unicode-雪.md' } });
    const textBlock = readWithText.content.find((item) => item.type === 'text');
    expect(textBlock?.type === 'text' && JSON.parse(textBlock.text)).toEqual(readWithText.structuredContent);
    const outlineResult = await client.callTool({ name: 'get_file_outline', arguments: { path: 'notes/unicode-雪.md' } });
    expect(outlineResult).toMatchObject({ structuredContent: { path: 'notes/unicode-雪.md', revision: expect.any(String), headings: expect.any(Array) } });
    await expect(client.callTool({ name: 'read_file', arguments: { path: 'notes/unicode-雪.md', startLine: 1, endLine: 1 } })).resolves.toMatchObject({ structuredContent: { startLine: 1, endLine: 1, totalLines: expect.any(Number) } });
    await expect(client.callTool({ name: 'search_files', arguments: { filters: [{ property: 'title', operator: 'eq', value: 'MCP fixture' }], properties: ['title'] } })).resolves.toMatchObject({ structuredContent: { results: [expect.objectContaining({ path: 'notes/frontmatter.md', properties: { title: 'MCP fixture' } })] } });
    await expect(client.callTool({ name: 'read_frontmatter', arguments: { path: 'notes/frontmatter.md' } })).resolves.toMatchObject({
      structuredContent: { frontmatter: { title: 'MCP fixture' } },
    });
    await expect(client.callTool({ name: 'list_attachments', arguments: { prefix: 'assets/' } })).resolves.toMatchObject({
      structuredContent: { attachments: [expect.objectContaining({ path: 'assets/mcp.png', sizeBytes: 3 })] },
    });
    await expect(client.callTool({ name: 'read_attachment', arguments: { path: 'assets/mcp.png' } })).resolves.toMatchObject({
      structuredContent: { contentBase64: 'AQID', mimeType: 'image/png' },
    });

    const created = await client.callTool({
      name: 'create_file',
      arguments: { path: 'notes/from-mcp.md', content: '# Created through MCP\r\n' },
    });
    const createdData = created.structuredContent as { revision: string };
    const appended = await client.callTool({
      name: 'append_file',
      arguments: { path: 'notes/from-mcp.md', content: 'tail\n', expectedRevision: createdData.revision },
    });
    const appendedData = appended.structuredContent as { revision: string };
    const patched = await client.callTool({
      name: 'patch_file',
      arguments: {
        path: 'notes/from-mcp.md', oldText: 'Created', newText: 'Draft', expectedRevision: appendedData.revision,
      },
    });
    const patchedData = patched.structuredContent as { revision: string };
    const frontmatterPatched = await client.callTool({
      name: 'patch_frontmatter',
      arguments: {
        path: 'notes/from-mcp.md', updates: { status: 'draft' }, expectedRevision: patchedData.revision,
      },
    });
    const frontmatterData = frontmatterPatched.structuredContent as { revision: string };
    await expect(client.callTool({ name: 'read_frontmatter', arguments: { path: 'notes/from-mcp.md' } })).resolves.toMatchObject({
      structuredContent: { frontmatter: { status: 'draft' } },
    });
    const edited = await client.callTool({
      name: 'edit_file',
      arguments: {
        path: 'notes/from-mcp.md',
        content: '# Edited through MCP\n',
        expectedRevision: frontmatterData.revision,
      },
    });
    const editedData = edited.structuredContent as { revision: string };
    await expect(client.callTool({
      name: 'delete_file',
      arguments: { path: 'notes/from-mcp.md', expectedRevision: editedData.revision },
    })).resolves.toMatchObject({ structuredContent: { path: 'notes/from-mcp.md' } });
    await expect(stub.readVaultFile({ path: 'notes/from-mcp.md' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('does not advertise writes when the kill switch is off', async () => {
    const name = `mcp-readonly-${crypto.randomUUID().replaceAll('-', '')}`;
    const stub = env.POUCH_DATABASES.getByName(name);
    await stub.ensureDatabase(name);
    const server = createVaultMcpServer(stub as unknown as VaultRpc, {
      writesEnabled: false,
      canRead: () => true,
      canWrite: () => true,
    });
    const client = new Client({ name: 'integration-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'vault_status', 'list_files', 'search_files', 'read_file', 'get_file_outline', 'read_frontmatter', 'list_attachments', 'read_attachment',
    ]);
  });
});
