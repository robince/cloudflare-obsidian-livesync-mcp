import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const UNSAFE_SPECIFIER = /^(?:file:|link:|git(?:\+[^:]+)?:|git@|https?:|ssh:|github:|gitlab:|bitbucket:|\.\.?\/)/i;
const REGISTRY_ALIAS = /^npm:(?:@[^/]+\/[^@]+|[^@/]+)@([^\s]+)$/;
const REGISTRY_INTEGRITY = /^(?:[a-z0-9]+-[A-Za-z0-9+/=]+)(?:\s+[a-z0-9]+-[A-Za-z0-9+/=]+)*$/i;
const REGISTRY_SELECTOR = /^(?:[A-Za-z][A-Za-z0-9._-]*|[0-9v*~^<>=xX][0-9A-Za-z.*~^<>=xX+_| -]*)$/;

function findWorkspacePaths(manifest, lockfile) {
  const patterns = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : (manifest.workspaces?.packages ?? []);
  return new Set(
    Object.keys(lockfile.packages ?? {}).filter((path) =>
      patterns.some((pattern) => {
        if (typeof pattern !== 'string') return false;
        if (!pattern.includes('*')) return path === pattern.replace(/\/$/, '');
        const [prefix, suffix] = pattern.split('*', 2);
        if (!path.startsWith(prefix) || !path.endsWith(suffix)) return false;
        const matched = path.slice(prefix.length, suffix ? path.length - suffix.length : path.length);
        return matched.length > 0 && !matched.includes('/');
      })
    )
  );
}

function safeDependencySpecifier(specifier) {
  if (typeof specifier !== 'string' || specifier.length === 0) return false;
  if (UNSAFE_SPECIFIER.test(specifier)) return false;
  if (!specifier.startsWith('npm:')) return REGISTRY_SELECTOR.test(specifier);
  const alias = REGISTRY_ALIAS.exec(specifier);
  return alias !== null && REGISTRY_SELECTOR.test(alias[1]);
}

function isRegistryTarball(resolved, registry) {
  try {
    const tarball = new URL(resolved);
    const base = new URL(registry);
    const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
    return tarball.protocol === base.protocol
      && tarball.host === base.host
      && tarball.username === base.username
      && tarball.password === base.password
      && tarball.pathname.startsWith(basePath)
      && tarball.pathname.includes('/-/')
      && tarball.pathname.endsWith('.tgz')
      && tarball.search === ''
      && tarball.hash === '';
  } catch {
    return false;
  }
}

function productionEdges(entry) {
  const edges = new Map();
  for (const [name, specifier] of Object.entries(entry.dependencies ?? {})) {
    edges.set(name, { specifier, optional: false });
  }
  for (const [name, specifier] of Object.entries(entry.optionalDependencies ?? {})) {
    edges.set(name, { specifier, optional: true });
  }
  for (const [name, specifier] of Object.entries(entry.peerDependencies ?? {})) {
    if (edges.has(name)) continue;
    const optional = entry.peerDependenciesMeta?.[name]?.optional === true;
    edges.set(name, { specifier, optional });
  }
  return edges;
}

function resolveDependencyPath(packages, parentPath, dependencyName) {
  let cursor = parentPath;
  while (true) {
    const candidate = `${cursor ? `${cursor}/` : ''}node_modules/${dependencyName}`;
    if (Object.hasOwn(packages, candidate)) return candidate;
    if (cursor === '') return undefined;
    const separator = cursor.lastIndexOf('/');
    cursor = separator === -1 ? '' : cursor.slice(0, separator);
  }
}

export function validateProductionDependencies({ manifest, lockfile, registry }) {
  if (!lockfile.packages || typeof lockfile.packages !== 'object') {
    return ['package-lock.json does not contain a packages map'];
  }

  let registryUrl;
  try {
    registryUrl = new URL(registry).href;
  } catch {
    return [`npm registry is not a valid URL: ${registry}`];
  }

  const problems = [];
  const workspaces = findWorkspacePaths(manifest, lockfile);
  const workspaceNames = new Set(
    [...workspaces]
      .map((path) => lockfile.packages[path]?.name)
      .filter((name) => typeof name === 'string')
  );
  const workspaceByName = new Map(
    [...workspaces]
      .map((path) => [lockfile.packages[path]?.name, path])
      .filter(([name]) => typeof name === 'string')
  );
  const queue = ['', ...workspaces];
  const reachable = new Set();

  while (queue.length > 0) {
    const path = queue.shift();
    if (path === undefined || reachable.has(path)) continue;
    reachable.add(path);
    const entry = lockfile.packages[path];
    if (!entry) {
      problems.push(`${path || '<root>'}: reachable package is missing from the lockfile`);
      continue;
    }

    for (const [name, { specifier, optional }] of productionEdges(entry)) {
      const workspaceSpecifier = typeof specifier === 'string'
        && specifier.startsWith('workspace:')
        && workspaceNames.has(name);
      if (!workspaceSpecifier && !safeDependencySpecifier(specifier)) {
        problems.push(`${path || '<root>'}: ${name} uses untrusted specifier ${specifier}`);
      }

      const dependencyPath = workspaceSpecifier
        ? workspaceByName.get(name)
        : resolveDependencyPath(lockfile.packages, path, name);
      if (dependencyPath) {
        queue.push(dependencyPath);
      } else if (!optional) {
        problems.push(`${path || '<root>'}: cannot resolve production dependency ${name}`);
      }
    }

    if (path === '' || workspaces.has(path)) continue;

    if (entry.link === true) {
      const target = typeof entry.resolved === 'string' ? entry.resolved.replaceAll('\\', '/').replace(/\/$/, '') : '';
      if (workspaces.has(target)) {
        queue.push(target);
      } else {
        problems.push(`${path}: is a non-workspace link to ${entry.resolved ?? '<missing>'}`);
      }
      continue;
    }

    if (typeof entry.resolved !== 'string' || entry.resolved.length === 0) {
      problems.push(`${path}: has no registry provenance (missing resolved URL)`);
    } else if (!isRegistryTarball(entry.resolved, registryUrl)) {
      problems.push(`${path}: resolves outside the configured npm registry: ${entry.resolved}`);
    }

    if (typeof entry.integrity !== 'string' || !REGISTRY_INTEGRITY.test(entry.integrity)) {
      problems.push(`${path}: has no valid registry integrity`);
    }
    if (typeof entry.version !== 'string' || entry.version.length === 0 || UNSAFE_SPECIFIER.test(entry.version)) {
      problems.push(`${path}: has no unambiguous registry version`);
    }
  }

  return problems;
}

async function main() {
  const root = process.cwd();
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const lockfile = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
  const registry = execFileSync('npm', ['config', 'get', 'registry'], { encoding: 'utf8' }).trim();
  const problems = validateProductionDependencies({ manifest, lockfile, registry });

  if (problems.length > 0) {
    console.error('Production dependencies must be integrity-checked npm registry tarballs:');
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
  } else {
    console.log(`Production dependency lock check passed for ${registry}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
