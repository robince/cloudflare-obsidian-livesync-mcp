import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateProductionDependencies } from '../scripts/check-production-dependencies.mjs';

const registry = 'https://registry.npmjs.org/';
const manifest = { workspaces: ['apps/*', 'packages/*'] };

function lockWith(packageEntry, dependencySpecifier = '^1.0.0') {
  return {
    packages: {
      '': { dependencies: { example: dependencySpecifier } },
      'apps/mcp': { name: '@example/mcp', version: '1.0.0' },
      'node_modules/@example/mcp': { resolved: 'apps/mcp', link: true },
      'node_modules/example': packageEntry,
      'node_modules/dev-only': { version: '1.0.0', dev: true },
    },
  };
}

const registryEntry = {
  version: '1.0.0',
  resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
  integrity: 'sha512-YWJjZA==',
};

describe('production dependency provenance', () => {
  it('accepts integrity-checked registry tarballs and declared workspace links', () => {
    assert.deepEqual(validateProductionDependencies({
      manifest,
      lockfile: lockWith(registryEntry),
      registry,
    }), []);
  });

  it('accepts registry aliases when their lock entry proves registry provenance', () => {
    assert.deepEqual(validateProductionDependencies({
      manifest,
      lockfile: lockWith(registryEntry, 'npm:@example/actual@1.0.0'),
      registry,
    }), []);
  });

  const rejected = [
    ['file dependency', registryEntry, 'file:../example'],
    ['link dependency', registryEntry, 'link:../example'],
    ['undeclared workspace dependency', registryEntry, 'workspace:*'],
    ['ambiguous registry alias', registryEntry, 'npm:@example/actual'],
    ['git dependency', { ...registryEntry, resolved: 'git+https://github.com/example/example.git' }, '^1.0.0'],
    ['arbitrary URL', { ...registryEntry, resolved: 'https://downloads.example.com/example.tgz' }, '^1.0.0'],
    ['missing resolved provenance', { version: '1.0.0', integrity: 'sha512-YWJjZA==' }, '^1.0.0'],
    ['missing integrity provenance', { version: '1.0.0', resolved: registryEntry.resolved }, '^1.0.0'],
    ['missing version provenance', { resolved: registryEntry.resolved, integrity: 'sha512-YWJjZA==' }, '^1.0.0'],
    ['non-workspace link', { resolved: '../example', link: true }, '^1.0.0'],
  ];

  for (const [name, entry, specifier] of rejected) {
    it(`rejects ${name}`, () => {
      assert.notDeepEqual(validateProductionDependencies({
        manifest,
        lockfile: lockWith(entry, specifier),
        registry,
      }), []);
    });
  }

  it('rejects a poisoned direct production dependency marked dev', () => {
    assert.notDeepEqual(validateProductionDependencies({
      manifest,
      lockfile: lockWith({
        ...registryEntry,
        dev: true,
        resolved: 'https://downloads.example.com/example.tgz',
      }),
      registry,
    }), []);
  });

  it('does not treat nested node_modules paths as workspace packages', () => {
    const lockfile = {
      packages: {
        '': { dependencies: { '@example/mcp': 'workspace:*' } },
        'apps/mcp': { name: '@example/mcp', version: '1.0.0', dependencies: { poisoned: '^1.0.0' } },
        'node_modules/@example/mcp': { resolved: 'apps/mcp', link: true },
        'apps/mcp/node_modules/poisoned': {
          version: '1.0.0',
          resolved: 'git+https://github.com/example/poisoned.git',
        },
      },
    };
    const problems = validateProductionDependencies({ manifest, lockfile, registry });
    assert.ok(problems.includes(
      'apps/mcp/node_modules/poisoned: resolves outside the configured npm registry: git+https://github.com/example/poisoned.git'
    ));
  });

  it('rejects a poisoned transitive production dependency marked dev', () => {
    const lockfile = lockWith({
      ...registryEntry,
      dependencies: { poisoned: '^1.0.0' },
    });
    lockfile.packages['node_modules/poisoned'] = {
      ...registryEntry,
      dev: true,
      resolved: 'git+https://github.com/example/poisoned.git',
    };
    assert.notDeepEqual(validateProductionDependencies({ manifest, lockfile, registry }), []);
  });

  it('validates required peer dependencies and rejects poisoned provenance', () => {
    const lockfile = lockWith({
      ...registryEntry,
      peerDependencies: { poisoned: '^1.0.0' },
    });
    lockfile.packages['node_modules/poisoned'] = {
      ...registryEntry,
      resolved: 'git+https://github.com/example/poisoned.git',
    };
    const problems = validateProductionDependencies({ manifest, lockfile, registry });
    assert.ok(problems.includes(
      'node_modules/poisoned: resolves outside the configured npm registry: git+https://github.com/example/poisoned.git'
    ));
  });

  it('allows a missing peer explicitly marked optional', () => {
    assert.deepEqual(validateProductionDependencies({
      manifest,
      lockfile: lockWith({
        ...registryEntry,
        peerDependencies: { optionalPeer: '^1.0.0' },
        peerDependenciesMeta: { optionalPeer: { optional: true } },
      }),
      registry,
    }), []);
  });
});

it('pins the schema-2 adapter and resolves its core to the root registry alias', () => {
  const version = '1.1.2-cloudflare-do.1';
  const root = new URL('../', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('package.json', root)));
  const lock = JSON.parse(readFileSync(new URL('package-lock.json', root)));
  assert.equal(manifest.dependencies['@robince/pouchdb-adapter-cloudflare-do'], version);
  assert.equal(manifest.dependencies['pouchdb-adapter-sqlite-core'], `npm:@robince/pouchdb-adapter-sqlite-core@${version}`);
  const coreEntries = Object.entries(lock.packages).filter(([path]) => path.endsWith('/pouchdb-adapter-sqlite-core'));
  assert.equal(coreEntries.length, 1);
  assert.equal(coreEntries[0][1].version, version);
  const require = createRequire(import.meta.url);
  const adapter = require.resolve('@robince/pouchdb-adapter-cloudflare-do');
  assert.equal(createRequire(adapter).resolve('pouchdb-adapter-sqlite-core'), require.resolve('pouchdb-adapter-sqlite-core'));
  const installed = JSON.parse(readFileSync(new URL('node_modules/@robince/pouchdb-adapter-cloudflare-do/package.json', root)));
  assert.equal(installed.version, version);
  assert.equal(installed.dependencies['pouchdb-adapter-sqlite-core'], manifest.dependencies['pouchdb-adapter-sqlite-core']);
  const constants = readFileSync(new URL('node_modules/pouchdb-adapter-sqlite-core/lib/constants.js', root), 'utf8');
  assert.match(constants, /ADAPTER_VERSION = 2;/);
});
