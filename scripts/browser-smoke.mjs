import { chromium } from 'playwright-core';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const binary = process.env.CHROMIUM_PATH ?? path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1243/chrome-win64/chrome.exe');
const original = process.env.ORIGINAL_EXTENSION_PATH ?? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/User Data/Default/Extensions/lmjnegcaeklhafolokijcfjliaokphfk/10.6.1.2_0');
const ours = path.resolve('dist');
const profile = await mkdtemp(path.join(tmpdir(), 'media-detection-smoke-'));
const context = await chromium.launchPersistentContext(profile, { executablePath: binary, headless: true,
  args: [`--disable-extensions-except=${ours},${original}`, `--load-extension=${ours},${original}`, '--remote-debugging-port=9223'] });
const errors = [];
context.on('serviceworker', worker => worker.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); }));
try {
  await new Promise(r => setTimeout(r, 1500));
  const workers = context.serviceWorkers();
  console.log(JSON.stringify({ browser: context.browser()?.version(), workers: workers.map(w => w.url()), profile }));
  const worker = workers.find(w => !w.url().includes('lmjnegcaeklhafolokijcfjliaokphfk'));
  if (!worker) throw Error('New extension worker unavailable');
  const id = new URL(worker.url()).hostname;
  const page = await context.newPage();
  await page.goto('https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4');
  await page.waitForTimeout(2000);
  const snapshot = await worker.evaluate(async () => (await chrome.storage.session.get('detectionState')).detectionState);
  const originalWorker = workers.find(w => w.url().includes('lmjnegcaeklhafolokijcfjliaokphfk'));
  const originalRaw = originalWorker ? await originalWorker.evaluate(async () => (await chrome.storage.session.get('global_session_state')).global_session_state) : undefined;
  const result = { browser: context.browser()?.version(), extensionId: id, profile, snapshot, originalAvailable: !!originalRaw, errors };
  await writeFile('test-results/browser-smoke.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ours: Object.values(snapshot?.tabs ?? {}).map(t => ({ url: t.url, count: Object.keys(t.media).length })), originalAvailable: !!originalRaw, errors }));
} finally { await context.close(); }
