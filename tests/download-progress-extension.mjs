// Real built MV3 action popup -> offscreen -> worker -> durable storage/UI proof.
// Run after npm.cmd run build: node --experimental-strip-types tests/download-progress-extension.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { fixtures, scratch } from './download-fixtures.ts';

fixtures();
const output = path.resolve('.cache/download-progress-extension'); await mkdir(output, { recursive: true });
const report = { observations: 'Read chrome.storage.local and popup DOM only; no test download-snapshot requests', requests: [], errors: [] };
report.sourceHashes = Object.fromEntries(await Promise.all(['src/downloads/remux.ts', 'src/downloads/offscreen.ts', 'src/downloads/change-notifier.ts'].map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const artifactHashes = () => Promise.all(['download-worker.js', 'offscreen.js', 'background.js', 'popup/index.js'].map(async file => [file, createHash('sha256').update(await readFile(path.resolve('dist', file))).digest('hex')]));
report.artifactBefore = Object.fromEntries(await artifactHashes());
const sockets = new Set(); let held; let mediaBytes = 0; let context; let popup;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://fixture.test');
    if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Progress fixture</title><video preload="none" src="/master.m3u8"></video>'); return; }
    if (url.pathname === '/master.m3u8') { res.setHeader('content-type', 'application/vnd.apple.mpegurl'); res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"\n/ts720/list.m3u8'); return; }
    if (!/^\/ts720\/(list\.m3u8|part[012]\.ts)$/.test(url.pathname)) { res.writeHead(404).end(); return; }
    report.requests.push({ path: url.pathname, range: req.headers.range, origin: req.headers.origin, referer: req.headers.referer });
    let bytes = await readFile(path.resolve(scratch, '.' + url.pathname));
    if (url.pathname.endsWith('.m3u8')) bytes = Buffer.from(bytes.toString().replace('#EXT-X-TARGETDURATION:0', '#EXT-X-TARGETDURATION:1'));
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    const start = match ? Number(match[1]) : 0, end = match?.[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
    res.writeHead(match ? 206 : 200, { 'content-type': url.pathname.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
      'content-length': end - start + 1, ...(match ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {}) });
    const engineRange = /^bytes=\d+-\d+$/.test(req.headers.range || '');
    if (engineRange && url.pathname.endsWith('/part1.ts')) { mediaBytes += 64; res.write(bytes.subarray(start, start + 64)); held = { res, bytes, offset: start + 64 }; return; }
    if (engineRange && url.pathname.endsWith('.ts')) mediaBytes += end - start + 1;
    res.end(bytes.subarray(start, end + 1));
  } catch (error) { res.destroy(error); }
});
server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, accept, label, ms = 8000) {
  const end = Date.now() + ms; let value;
  while (Date.now() < end) { value = await read(); if (accept(value)) return value; await delay(40); }
  throw Error(`${label}: ${JSON.stringify(value)}`);
}
async function connect(port, url) {
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.url === url), Boolean, 'popup target');
  const socket = new WebSocket(target.webSocketDebuggerUrl); let id = 0; const pending = new Map();
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', ({ data }) => { const result = JSON.parse(data), p = pending.get(result.id); if (p) { pending.delete(result.id); clearTimeout(p.timer); result.error ? p.reject(Error(JSON.stringify(result.error))) : p.resolve(result.result); } });
  return { close: () => socket.close(), async evaluate(fn, arg) {
    const result = await new Promise((resolve, reject) => {
      const next = ++id, timer = setTimeout(() => { pending.delete(next); reject(Error('popup evaluation timeout')); }, 5000);
      pending.set(next, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: next, method: 'Runtime.evaluate', params: { expression: `(${fn.toString()})(${JSON.stringify(arg)})`, awaitPromise: true, returnByValue: true } }));
    });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
  } };
}
const readState = () => popup.evaluate(async () => ({ jobs: (await chrome.storage.local.get('downloadState')).downloadState?.jobs ?? [], ui: document.querySelector('.download-jobs')?.textContent }));
try {
  const extension = path.resolve('dist');
  report.profile = await mkdtemp(path.join(tmpdir(), 'owned-progress-extension-'));
  context = await chromium.launchPersistentContext(report.profile, { executablePath: process.env.CHROMIUM_PATH || 'C:/Users/jay03/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--remote-debugging-port=0'] });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  report.extensionId = new URL(worker.url()).hostname;
  const page = await context.newPage(); await page.goto(origin); await page.bringToFront();
  await worker.evaluate(() => chrome.action.openPopup());
  const port = Number((await readFile(path.join(report.profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
  popup = await connect(port, `chrome-extension://${report.extensionId}/popup/index.html`);
  await until(() => popup.evaluate(() => [...document.querySelectorAll('.download-start')].some(b => !b.disabled)), Boolean, 'enabled Download');
  await popup.evaluate(() => document.querySelector('.download-start:not(:disabled)').click());
  await until(() => Promise.resolve(!!held), Boolean, 'later configuration segment held');
  report.expectedInputBytes = mediaBytes;
  report.first = await until(readState, s => s.jobs[0]?.progress.inputBytes === mediaBytes, 'durable live input progress');
  assert.equal(report.first.jobs[0].progress.outputBytes, 0); assert.equal(report.first.jobs[0].progress.seconds, 0);
  assert.ok(report.first.ui.includes(mediaBytes.toLocaleString('en-US')), 'popup renders the persisted actual input bytes');
  // A second real network chunk must advance the already-open popup with no command or snapshot request.
  held.res.write(held.bytes.subarray(held.offset, held.offset + 64)); held.offset += 64; mediaBytes += 64;
  report.second = await until(readState, s => s.jobs[0]?.progress.inputBytes === mediaBytes, 'second durable live input progress');
  assert.ok(report.second.ui.includes(mediaBytes.toLocaleString('en-US'))); assert.equal(report.second.jobs[0].progress.outputBytes, 0);
  report.actualInputBytes = mediaBytes;
  await popup.evaluate(() => [...document.querySelectorAll('.download-jobs button')].find(b => b.textContent === 'Cancel').click());
  report.cleanup = await until(readState, s => s.jobs[0]?.phase === 'canceled' && !s.jobs[0].attachment && !s.jobs[0].tempFile, 'canceled cleanup');
  report.nativeCleanup = await popup.evaluate(async () => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('media-downloads-v1');
    const files = []; for await (const name of directory.keys()) files.push(name);
    return { files, browserDownloads: (await chrome.downloads.search({})).length };
  });
  assert.deepEqual(report.nativeCleanup, { files: [], browserDownloads: 0 });
  await delay(1100); report.afterRelease = await readState();
  assert.equal(report.afterRelease.jobs[0].updatedAt, report.cleanup.jobs[0].updatedAt);
  report.ok = true;
} catch (error) { report.ok = false; report.errors.push(error.stack || String(error)); process.exitCode = 1; }
finally {
  // Also settle the intentionally stalled RED job through the real popup command.
  if (popup && !report.cleanup) {
    try { await popup.evaluate(() => [...document.querySelectorAll('.download-jobs button')].find(b => b.textContent === 'Cancel')?.click()); report.cleanup = await until(readState, s => s.jobs[0]?.phase === 'canceled' && !s.jobs[0].attachment && !s.jobs[0].tempFile, 'RED cleanup'); }
    catch (error) { report.errors.push('cleanup: ' + error.message); }
  }
  popup?.close(); await context?.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
  report.artifactAfter = Object.fromEntries(await artifactHashes()); assert.deepEqual(report.artifactAfter, report.artifactBefore);
  await writeFile(path.join(output, 'evidence.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
}
