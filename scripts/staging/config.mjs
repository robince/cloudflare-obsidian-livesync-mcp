export const LIVESYNC_COMMIT = 'f5f7aab11f03f62c6946d2fa296c50bb5df5b2a4';
export const REQUIRED = [
  'STAGING_LIVESYNC_ROOT', 'STAGING_COUCH_URL', 'STAGING_COUCH_USER',
  'STAGING_COUCH_PASSWORD', 'STAGING_DATABASE', 'STAGING_MCP_URL',
  'STAGING_MCP_WRITE_TOKEN', 'STAGING_MCP_READ_TOKEN',
];

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function stagingWorkerOrigin(value, workerName, workersDevSubdomain) {
  if (!DNS_LABEL.test(workerName) || !DNS_LABEL.test(workersDevSubdomain)) {
    throw new Error('Expected valid staging Worker and workers.dev account names.');
  }
  const url = new URL(value);
  const expectedHostname = `${workerName}.${workersDevSubdomain}.workers.dev`;
  if (url.protocol !== 'https:' || url.hostname !== expectedHostname
    || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error(`Expected the exact staging Worker origin https://${expectedHostname}`);
  }
  return url.origin;
}

export function stagingConfig(env) {
  const missing = REQUIRED.filter(key => !env[key]);
  if (missing.length) throw new Error(`Missing staging configuration: ${missing.join(', ')}`);
  if (env.STAGING_CONFIRM_DISPOSABLE !== 'yes') throw new Error('Set STAGING_CONFIRM_DISPOSABLE=yes for the disposable environment only.');
  if (!/^mcp-conflict-staging-[a-z0-9]{8,40}$/.test(env.STAGING_DATABASE)) {
    throw new Error('Staging database must have a unique mcp-conflict-staging- prefix and 8–40 lowercase alphanumeric suffix.');
  }
  for (const key of ['STAGING_COUCH_URL', 'STAGING_MCP_URL']) {
    const url = new URL(env[key]);
    if (url.username || url.password || url.search || url.hash) throw new Error(`Do not put credentials or query parameters in ${key}.`);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
      throw new Error(`${key} requires HTTPS except on localhost.`);
    }
  }
  for (const key of ['E2E_OBSIDIAN_ARGS', 'E2E_OBSIDIAN_USE_USER_DATA_DIR']) {
    if (env[key]) throw new Error(`Remove ${key}; staging requires the runner's isolated profile defaults.`);
  }
  return {
    root: env.STAGING_LIVESYNC_ROOT,
    couch: env.STAGING_COUCH_URL.replace(/\/$/, ''),
    username: env.STAGING_COUCH_USER, password: env.STAGING_COUCH_PASSWORD,
    database: env.STAGING_DATABASE, mcp: env.STAGING_MCP_URL,
    writeToken: env.STAGING_MCP_WRITE_TOKEN, readToken: env.STAGING_MCP_READ_TOKEN,
  };
}
