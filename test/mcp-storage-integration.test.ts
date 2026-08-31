import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';

import { createVaultMcpServer } from '../apps/cloudflare-obsidian-mcp/src/vault-tools';
import type { VaultRpc } from '../apps/cloudflare-obsidian-mcp/src/vault-rpc';
import fixture from './fixtures/livesync-1.0.21.json';
import type { JsonObject } from '../src/types';

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
  it('lists, reads, creates, edits, and deletes through real RPC serialization', async () => {
    const name = `mcp-integration-${crypto.randomUUID().replaceAll('-', '')}`;
    const stub = env.POUCH_DATABASES.getByName(name);
    await stub.ensureDatabase(name);
    for (const document of fixture.documents) {
      await stub.putDocument(name, withoutRevision(document as JsonObject));
    }
    for (const document of Object.values(fixture.localDocuments)) {
      await stub.putDocument(name, withoutRevision(document as JsonObject));
    }

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
      'vault_status', 'list_files', 'read_file', 'create_file', 'edit_file', 'delete_file',
    ]);
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
    await expect(client.callTool({ name: 'read_file', arguments: { path: 'notes/unicode-雪.md' } })).resolves.toMatchObject({
      structuredContent: { content: fixture.files['notes/unicode-雪.md'] },
    });

    const created = await client.callTool({
      name: 'create_file',
      arguments: { path: 'notes/from-mcp.md', content: '# Created through MCP\r\n' },
    });
    const createdData = created.structuredContent as { revision: string };
    const edited = await client.callTool({
      name: 'edit_file',
      arguments: {
        path: 'notes/from-mcp.md',
        content: '# Edited through MCP\n',
        expectedRevision: createdData.revision,
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
      'vault_status', 'list_files', 'read_file',
    ]);
  });
});
