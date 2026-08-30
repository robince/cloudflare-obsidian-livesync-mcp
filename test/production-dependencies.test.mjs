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
});
