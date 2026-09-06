import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export function deploymentConfig(text, environment = '') {
  const { config, error } = ts.parseConfigFileTextToJson('wrangler.jsonc', text);
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  const selected = environment ? config.env?.[environment] : config;
  if (!selected) throw new Error(`Missing deployment environment: ${environment}`);
  const enabled = selected.vars?.BACKUP_ENABLED;
  if (enabled !== 'true' && enabled !== 'false') {
    throw new Error('Set BACKUP_ENABLED to the string "true" or "false" in the selected configuration.');
  }
  if (enabled === 'true') return null;
  selected.r2_buckets = (selected.r2_buckets ?? []).filter(bucket => bucket.binding !== 'BACKUP_BUCKET');
  // An empty list removes deployed cron triggers; omitting it leaves them running.
  selected.triggers = { ...selected.triggers, crons: [] };
  return config;
}

export function deployStorage([configPath, environment, ...args]) {
  if (!configPath || environment === undefined) throw new Error('Usage: deploy-storage.mjs CONFIG ENV [Wrangler deploy options]');
  if (args.some(arg => /^(--config|--env|--var|-c|-e)(=|$)/.test(arg))) {
    throw new Error('Set configuration, environment and variables in the deployment config, not extra Wrangler options.');
  }
  const source = resolve(configPath);
  const config = deploymentConfig(readFileSync(source, 'utf8'), environment);
  // Keep the copy beside the original so relative entrypoints and secret files still resolve.
  const temporary = config ? join(dirname(source), `.wrangler-deploy-${randomUUID()}.jsonc`) : null;
  const require = createRequire(import.meta.url);
  const wrangler = join(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js');
  try {
    if (temporary) writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
    const result = spawnSync(process.execPath, [wrangler, 'deploy', '--config', temporary ?? source, '--env', environment, ...args], { stdio: 'inherit' });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    if (temporary) rmSync(temporary, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = deployStorage(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
