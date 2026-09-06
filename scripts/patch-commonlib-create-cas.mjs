import { readFile, writeFile } from 'node:fs/promises';

const packagePath = new URL('../node_modules/@vrtmrz/livesync-commonlib/package.json', import.meta.url);
const implementationPath = new URL(
  '../node_modules/@vrtmrz/livesync-commonlib/dist/managers/EntryManager/EntryManagerImpls.js',
  import.meta.url,
);
const expectedVersion = '0.1.23';
const original = `if (revisionTarget.mode !== "latest") {
        newDoc._rev = revisionTarget.baseRevision;
      }`;
const incorrectPatch = `if (revisionTarget.mode !== "latest" && revisionTarget.baseRevision !== void 0) {
        newDoc._rev = revisionTarget.baseRevision;
      }`;
const patched = `if (revisionTarget.mode !== "latest") {
        if (revisionTarget.baseRevision !== void 0) {
          newDoc._rev = revisionTarget.baseRevision;
        }
      }`;

const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
if (packageJson.version !== expectedVersion) {
  throw new Error(`Refusing to patch livesync-commonlib ${packageJson.version}; expected ${expectedVersion}.`);
}

const implementation = await readFile(implementationPath, 'utf8');
if (implementation.includes(patched)) process.exit(0);
const source = implementation.includes(original) ? original : incorrectPatch;
if (!implementation.includes(source)) {
  throw new Error('The livesync-commonlib create-CAS patch no longer matches its pinned source.');
}
await writeFile(implementationPath, implementation.replace(source, patched));
