import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { startStagingSession, canDisposeStagingVault } from './session.mjs';
const root = process.env.STAGING_LIVESYNC_ROOT;
if (!root) throw new Error('Set STAGING_LIVESYNC_ROOT');
const load = name => import(pathToFileURL(join(root, 'test/e2e-obsidian/runner', `${name}.ts`)).href);
const { requireObsidianBinary, discoverObsidianCli } = await load('environment');
const { createTemporaryVault } = await load('vault');
const { inspectObsidianServiceContextContract, assertObsidianServiceContextContract } = await load('liveSyncWorkflow');
const output = await mkdtemp(join(tmpdir(), 'mcp-client-bootstrap-'));
console.log(`Bootstrap diagnostics: ${output}`);
for (const label of ['a', 'b']) {
  const vault = await createTemporaryVault(`mcp-client-smoke-${label}-`);
  let session;
  try {
    session = await startStagingSession(root, {
      binary: requireObsidianBinary(), cliBinary: discoverObsidianCli().binary,
      artifactRoot: root, vault, diagnosticsDir: output,
    });
    assertObsidianServiceContextContract(await inspectObsidianServiceContextContract(discoverObsidianCli().binary, session.cliEnv));
    console.log(`Real isolated client ${label} loaded pinned LiveSync successfully.`);
  } finally {
    if (session) await session.app.stop();
    if (canDisposeStagingVault(vault)) await vault.dispose();
  }
}
