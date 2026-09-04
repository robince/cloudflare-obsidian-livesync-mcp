import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const preservedVaults = new Set();
const stagingPorts = new Set();
const patchedChromium = new WeakSet();
export const canDisposeStagingVault = vault => !preservedVaults.has(vault.path);

/** Host-version shim only; the pinned LiveSync plug-in/merge code is unchanged. */
export async function startStagingSession(root, options) {
  const load = name => import(pathToFileURL(join(root, 'test/e2e-obsidian/runner', `${name}.ts`)).href);
  const { startObsidianLiveSyncSession } = await load('session');
  const { withObsidianPage } = await load('ui');
  const { obsidianRemoteDebuggingPort } = await load('ui');
  stagingPorts.add(String(obsidianRemoteDebuggingPort()));
  const { chromium } = createRequire(join(root, 'package.json'))('playwright');
  if (!patchedChromium.has(chromium)) {
    patchedChromium.add(chromium);
    const connect = chromium.connectOverCDP.bind(chromium);
    chromium.connectOverCDP = async (endpoint, ...args) => {
      const browser = await connect(endpoint, ...args);
      const url = new URL(endpoint);
      if (url.hostname !== '127.0.0.1' || !stagingPorts.has(url.port)) return browser;
      // Upstream selects pages()[0]. Electron can expose an empty target first
      // on a new CDP connection even after the app has loaded. Prefer the real
      // renderer only in this process's explicitly registered staging ports.
      for (const context of browser.contexts()) {
        const pages = context.pages.bind(context);
        const deadline = Date.now() + 30000;
        while (!pages().some(page => page.url().startsWith('app://obsidian.md/'))) {
          if (Date.now() >= deadline) {
            await browser.close();
            throw new Error('Isolated Obsidian renderer did not appear');
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        context.pages = () => pages().sort((a, b) =>
          Number(b.url().startsWith('app://obsidian.md/')) - Number(a.url().startsWith('app://obsidian.md/')));
      }
      return browser;
    };
  }
  let observer;
  let failure;
  let session;
  let finished = false;
  let launched;
  try {
    session = await startObsidianLiveSyncSession({ ...options, artifactRoot: root,
      lifecycle: { afterLaunch: async ({ remoteDebuggingPort, app }) => {
        launched = app;
        observer = withObsidianPage(remoteDebuggingPort, async page => {
          const started = Date.now();
          let captured = false;
          const modal = page.locator('.modal-container.mod-confirmation')
            .filter({ hasText: 'Run action from external link?' }).last();
          while (!finished) {
          if (!captured && options.diagnosticsDir && Date.now() - started > 15000) {
            captured = true;
            await page.screenshot({ path: join(options.diagnosticsDir, 'bootstrap.png') });
            await writeFile(join(options.diagnosticsDir, 'bootstrap.txt'), await page.locator('body').innerText(), { mode: 0o600 });
            const pages = await Promise.all(page.context().pages().map(async candidate => ({
              url: candidate.url(),
              state: await candidate.evaluate(() => ({
                vault: globalThis.app?.vault?.getName(),
                manifests: Object.keys(globalThis.app?.plugins?.manifests ?? {}),
              })).catch(() => null),
            })));
            await writeFile(join(options.diagnosticsDir, 'bootstrap-pages.json'), JSON.stringify(pages), { mode: 0o600 });
          }
          const appeared = await modal.waitFor({ state: 'visible', timeout: 1000 })
            .then(() => true).catch(error => { if (error.name === 'TimeoutError') return false; throw error; });
          if (!appeared) continue;
          const text = await modal.innerText();
          if (!text.includes('The “open” action') || !text.split('\n').some(line => line.trim() === options.vault.path)) {
            if (options.diagnosticsDir) {
              await writeFile(join(options.diagnosticsDir, 'unexpected-open.json'),
                JSON.stringify({ expectedPath: options.vault.path, displayed: text }), { mode: 0o600 });
            }
            throw new Error('Refusing an external-link action for an unexpected vault');
          }
          // Approve only this generated test-vault open action. Do not disable
          // future prompts or change any normal Obsidian profile preference.
          await modal.getByRole('button', { name: 'Continue', exact: true }).click();
          await modal.waitFor({ state: 'hidden', timeout: 5000 });
          }
        }).catch(error => { failure = error; });
      } },
    });
    finished = true;
    await observer;
    if (failure) { await session.app.stop(); throw failure; }
    return session;
  } catch (error) {
    finished = true;
    if (observer) await observer;
    if (options.diagnosticsDir) {
      await writeFile(join(options.diagnosticsDir, 'startup-error.txt'), String(error.stack ?? error), { mode: 0o600 });
    }
    try { if (launched) await launched.stop(); }
    catch { preservedVaults.add(options.vault.path); }
    throw error;
  } finally {
    finished = true;
    if (observer) await observer;
  }
}
