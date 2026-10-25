// Actual action-popup controls, owned generated media/profile, independent saved-file validation.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { fixtures, scratch } from './download-fixtures.ts';

const output = path.resolve('.cache/download-popup', `native-${Date.now()}-${process.pid}`);
await mkdir(output, { recursive: true });
if (!existsSync(path.join(scratch, 'mux720/list.m3u8')) || !existsSync(path.join(scratch, 'ts1080/list.m3u8'))) fixtures();
const report = { started: new Date().toISOString(), output, cases: [], errors: [] };
const sockets = new Set(), timers = new Set(), targets = new Set();
let context, origin, slow = true;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture.test');
  if (url.pathname === '/watch') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Owned popup fixture</title><video src="/master.m3u8"></video>'); return;
  }
  if (url.pathname === '/master.m3u8') {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' });
    res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"\n/ts1080/list.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"\n/mux720/list.m3u8\n'); return;
  }
  const filename = path.resolve(scratch, '.' + url.pathname);
  if (!filename.startsWith(path.resolve(scratch) + path.sep) || !existsSync(filename)) { res.writeHead(404).end(); return; }
  let bytes = readFileSync(filename);
  if (url.pathname.endsWith('.m3u8')) bytes = Buffer.from(bytes.toString().replace('#EXT-X-TARGETDURATION:0', '#EXT-X-TARGETDURATION:1'));
  const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
  const start = match ? Number(match[1]) : 0, end = match ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
  res.writeHead(match ? 206 : 200, { 'content-type': url.pathname.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'image/jpeg', 'content-length': end - start + 1, 'accept-ranges': 'bytes', 'cache-control': 'no-store', ...(match ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {}) });
  if (slow && url.pathname.endsWith('.m4s')) {
    res.flushHeaders(); let cursor = start;
    const timer = setInterval(() => {
      const next = Math.min(cursor + 1024, end + 1); res.write(bytes.subarray(cursor, next)); cursor = next;
      if (cursor > end) { clearInterval(timer); timers.delete(timer); res.end(); }
    }, 150);
    timers.add(timer); res.once('close', () => { clearInterval(timer); timers.delete(timer); });
  } else res.end(bytes.subarray(start, end + 1));
});
server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${server.address().port}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, predicate, label, timeout = 30000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) { last = await fn(); if (predicate(last)) return last; await sleep(80); }
  throw Error('Timeout ' + label + ': ' + JSON.stringify(last));
}
async function connectTarget(port, url) {
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(target => target.url === url), Boolean, 'DevTools target');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0; const pending = new Map(); targets.add(socket);
  const rejectPending = () => { for (const command of pending.values()) { clearTimeout(command.timer); command.reject(Error('DevTools target closed')); } pending.clear(); };
  socket.addEventListener('close', () => { rejectPending(); targets.delete(socket); });
  socket.addEventListener('error', rejectPending);
  socket.addEventListener('message', event => {
    const value = JSON.parse(event.data), command = pending.get(value.id); if (!command) return;
    clearTimeout(command.timer); pending.delete(value.id);
    value.error ? command.reject(Error(JSON.stringify(value.error))) : command.resolve(value.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (socket.readyState !== 1) { reject(Error('DevTools target closed')); return; }
    const n = ++id;
    const timer = setTimeout(() => { pending.delete(n); reject(Error('DevTools command timeout: ' + method)); }, 10000);
    pending.set(n, { resolve, reject, timer }); socket.send(JSON.stringify({ id: n, method, params }));
  });
  return { send, close: () => socket.close(), async evaluate(fn, arg) {
    const result = await send('Runtime.evaluate', { expression: '(' + fn.toString() + ')(' + JSON.stringify(arg) + ')', awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
  } };
}
try {
  const profile = await mkdtemp(path.join(tmpdir(), 'owned-download-popup-')); report.profile = profile;
  // Use native Chrome filename determination with this owned profile's download preferences.
  await mkdir(path.join(profile, 'Default'), { recursive: true });
  await writeFile(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: output, prompt_for_download: false, directory_upgrade: true } }));
  const extension = path.resolve('dist');
  context = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROMIUM_PATH ?? 'C:/Users/jay03/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe', acceptDownloads: false, headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--remote-debugging-port=0'] });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).hostname; report.extensionId = extensionId;
  const port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); assert.notEqual(port, 9222); report.debuggingPort = port;
  const cdp = await context.newCDPSession(context.pages()[0]); await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
  const page = await context.newPage(); await page.goto(origin + '/watch'); await page.bringToFront();
  const popupUrl = `chrome-extension://${extensionId}/popup/index.html`;
  let popup;
  const openPopup = async () => {
    const wake = await context.newPage(); await wake.goto(popupUrl); await wake.close(); await page.bringToFront();
    const boot = await connectTarget(port, worker.url()); await boot.evaluate(() => chrome.action.openPopup()); boot.close();
    popup = await connectTarget(port, popupUrl);
  };
  await openPopup();
  const capture = async name => {
    await popup.evaluate(() => document.fonts.ready.then(() => true));
    const result = await popup.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(output, name + '.png'); await writeFile(file, Buffer.from(result.data, 'base64')); return file;
  };
  const controls = await until(() => popup.evaluate(() => [...document.querySelectorAll('.primary-media article')].map(article => ({ title: article.querySelector('h3').textContent, options: [...article.querySelectorAll('select option')].map(option => option.textContent), ready: !!article.querySelector('.download-start') }))), rows => rows.some(row => row.ready && row.options.includes('720p') && row.options.includes('1080p')), 'actual controls');
  report.cases.push({ id: 'real-two-quality-action-popup', controls });
  const chosen = await popup.evaluate(() => {
    const article = [...document.querySelectorAll('.primary-media article')].find(article => article.querySelectorAll('select option').length === 2);
    const quality = article.querySelector('select'); quality.value = [...quality.options].find(option => option.textContent === '720p').value; quality.dispatchEvent(new Event('change', { bubbles: true }));
    const filename = article.querySelector('input'); const defaultFilename = filename.value; filename.value = 'Popup 720 fixture.mp4'; filename.dispatchEvent(new Event('input', { bubbles: true }));
    filename.focus(); filename.setSelectionRange(3, 8, 'backward');
    article.querySelector('.download-start').click(); article.querySelector('.download-start')?.click();
    return { quality: quality.value, defaultFilename };
  });
  assert.equal(chosen.defaultFilename, 'Owned popup fixture.mp4');
  const streaming = await until(() => popup.evaluate(async () => ({ jobs: (await chrome.storage.local.get('downloadState')).downloadState?.jobs, phase: document.querySelector('.job-phase')?.textContent })), value => value.jobs?.length === 1 && value.jobs[0].phase === 'processing', 'UI-started streaming job');
  const jobFocus = await popup.evaluate(() => { const filename = document.querySelector('.download-controls input'); return { active: document.activeElement === filename, value: filename.value, start: filename.selectionStart, end: filename.selectionEnd, direction: filename.selectionDirection }; });
  assert.deepEqual(jobFocus, { active: true, value: 'Popup 720 fixture.mp4', start: 3, end: 8, direction: 'backward' });
  const firstId = streaming.jobs[0].id; assert.equal(streaming.jobs[0].selection.height, 720); assert.equal(streaming.jobs[0].selection.requestedVariantId, chosen.quality);
  assert.equal(streaming.jobs[0].selection.filename, 'Popup 720 fixture.mp4');
  const beforeFocus = await popup.evaluate(() => {
    const filename = document.querySelector('.download-controls input'); filename.value = 'Keep my caret.mp4'; filename.dispatchEvent(new Event('input', { bubbles: true }));
    filename.focus(); filename.setSelectionRange(3, 8, 'backward'); filename.dataset.nativeMarker = 'before';
    return { revision: document.querySelector('.diagnostics').textContent, control: filename.dataset.control };
  });
  await page.evaluate(() => { const video = document.createElement('video'); video.src = '/unconfirmed.m3u8'; document.body.append(video); });
  const focus = await until(() => popup.evaluate(() => {
    const filename = document.querySelector('.download-controls input'); const quality = document.querySelector('select');
    return { active: document.activeElement === filename, value: filename.value, start: filename.selectionStart, end: filename.selectionEnd, direction: filename.selectionDirection, marker: filename.dataset.nativeMarker, quality: quality.options[quality.selectedIndex].textContent, revision: document.querySelector('.diagnostics').textContent };
  }), state => !state.marker && state.revision !== beforeFocus.revision, 'detection/job storage rerenders');
  assert.equal(focus.active, true); assert.equal(focus.value, 'Keep my caret.mp4'); assert.equal(focus.start, 3); assert.equal(focus.end, 8); assert.equal(focus.direction, 'backward'); assert.equal(focus.quality, '720p');
  await sleep(800);
  const widthScreenshot = await capture('00-width-check');
  const dimensions = await popup.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, body: document.body.getBoundingClientRect().width, overflow: [...document.querySelectorAll('*')].filter(e => e.getBoundingClientRect().right > document.documentElement.clientWidth).map(e=>({tag:e.tagName,cls:e.className,right:e.getBoundingClientRect().right,text:e.textContent?.slice(0,100)})) }));
  report.widthEvidence = { dimensions, screenshot: widthScreenshot };
  assert.equal(dimensions.body, 440); assert.ok(dimensions.scroll <= dimensions.client, JSON.stringify(dimensions)); assert.equal(dimensions.overflow.length, 0, JSON.stringify(dimensions));
  report.cases.push({ id: '720p-user-action-dedup-and-storage-focus-caret', job: streaming.jobs[0], jobFocus, focus, dimensions, screenshot: await capture('01-controls-progress') });
  await popup.evaluate(() => { setTimeout(() => window.close(), 50); return true; }); await sleep(150); popup.close();
  await openPopup();
  const reopened = await until(() => popup.evaluate(id => { const job = document.querySelector(`[data-job-id="${id}"]`); return job && { text: job.textContent, phase: job.querySelector('.job-phase').textContent }; }, firstId), job => job?.phase === 'Processing media', 'current job after popup reopening');
  await popup.evaluate(id => document.querySelector(`[data-job-id="${id}"]`).scrollIntoView(), firstId);
  report.cases.push({ id: 'close-reopen-current-job', reopened, screenshot: await capture('02-reopened') });
  await popup.evaluate(id => document.querySelector(`[data-job-id="${id}"] .download-cancel`).click(), firstId);
  await until(() => popup.evaluate(id => document.querySelector(`[data-job-id="${id}"] .job-phase`)?.textContent, firstId), phase => phase === 'Canceled', 'UI cancel');
  await until(() => popup.evaluate(async id => {
    const job = (await chrome.storage.local.get('downloadState')).downloadState.jobs.find(job => job.id === id);
    return job?.phase === 'canceled' && !job.attachment && !job.tempFile && !document.querySelector(`[data-job-id="${id}"] .download-retry`)?.disabled;
  }, firstId), Boolean, 'cancel cleanup safely settled before retry');
  slow = false;
  await popup.evaluate(id => document.querySelector(`[data-job-id="${id}"] .download-retry`).click(), firstId);
  const saved = await until(() => popup.evaluate(async () => ({ jobs: (await chrome.storage.local.get('downloadState')).downloadState.jobs, text: document.querySelector('.download-jobs').textContent })), value => value.jobs.length === 2 && value.jobs.some(job => job.phase === 'complete') && value.text.includes('Saved by Chrome'), 'UI retry and Chrome complete', 60000);
  assert.equal(saved.jobs.find(job => job.id === firstId).phase, 'canceled');
  const completed = saved.jobs.find(job => job.phase === 'complete'); assert.equal(completed.selection.height, 720);
  const browser = await popup.evaluate(async id => (await chrome.downloads.search({ id }))[0], completed.browserDownloadId);
  assert.equal(path.basename(browser.filename), 'Popup 720 fixture.mp4');
  assert.equal(browser.state, 'complete'); assert.equal(browser.byExtensionId, extensionId); assert.ok(existsSync(browser.filename));
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', browser.filename], { encoding: 'utf8' }));
  assert.deepEqual(probe.streams.map(track => track.codec_name), ['h264', 'aac']); assert.equal(probe.streams[0].height, 720); assert.ok(Math.abs(Number(probe.format.duration) - 1.2) < 0.1);
  execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', browser.filename, '-f', 'null', '-'], { stdio: 'pipe' });
  await popup.evaluate(() => document.querySelector('.download-jobs').scrollIntoView());
  report.cases.push({ id: 'UI-cancel-retry-independent-saved-file-validation', jobs: saved.jobs, browser, probe: { duration: probe.format.duration, streams: probe.streams.map(track => ({ codec: track.codec_name, height: track.height, channels: track.channels, frames: track.nb_frames })) }, decode: 'ffmpeg -xerror exit 0', screenshot: await capture('03-saved') });
  if (process.argv.includes('--repeat-settled')) {
    const snapshot = () => popup.evaluate(async () => ({ jobs: (await chrome.storage.local.get('downloadState')).downloadState.jobs,
      saves: (await chrome.downloads.search({})).filter(item => item.byExtensionId === chrome.runtime.id) }));
    let previous = completed;
    for (const reopen of [false, true]) {
      if (reopen) {
        await popup.evaluate(() => { setTimeout(() => window.close(), 50); return true; }); await sleep(150); popup.close();
        await openPopup();
        await until(() => popup.evaluate(() => !!document.querySelector('.download-controls select option')), Boolean, 'repeat controls after reopen');
      }
      const before = await snapshot();
      const buttonState = await popup.evaluate(() => {
        const article = [...document.querySelectorAll('.primary-media article')].find(article => article.querySelectorAll('select option').length === 2);
        const quality = article.querySelector('select'); quality.value = [...quality.options].find(option => option.textContent === '720p').value;
        quality.dispatchEvent(new Event('change', { bubbles: true }));
        const filename = article.querySelector('input'); filename.value = 'Popup 720 fixture.mp4'; filename.dispatchEvent(new Event('input', { bubbles: true }));
        const button = article.querySelector('.download-start'); button.scrollIntoView();
        return { text: button.textContent, disabled: button.disabled, quality: quality.options[quality.selectedIndex].textContent, filename: filename.value };
      });
      assert.deepEqual(buttonState, { text: 'Download again', disabled: false, quality: '720p', filename: 'Popup 720 fixture.mp4' });
      await sleep(600);
      const idle = await snapshot(); assert.equal(idle.jobs.length, before.jobs.length); assert.equal(idle.saves.length, before.saves.length);
      await popup.evaluate(() => { const button = document.querySelector('.download-start'); button.click(); button.click(); });
      const after = await until(snapshot, value => value.jobs.length === before.jobs.length + 1 && value.jobs.filter(job => job.phase === 'complete').length === before.jobs.filter(job => job.phase === 'complete').length + 1, 'one explicit renewed save', 60000);
      const repeated = after.jobs.find(job => !before.jobs.some(old => old.id === job.id));
      assert.notEqual(repeated.requestId, previous.requestId);
      assert.ok(!before.jobs.some(job => job.requestId === repeated.requestId));
      assert.equal(repeated.selection.filename, 'Popup 720 fixture.mp4'); assert.equal(repeated.selection.height, 720); assert.equal(repeated.selection.requestedVariantId, chosen.quality);
      assert.equal(after.saves.length, before.saves.length + 1, 'one explicit action yields exactly one Chrome save');
      const item = after.saves.find(item => item.id === repeated.browserDownloadId);
      assert.equal(item.state, 'complete'); assert.equal(path.basename(item.filename), `Popup 720 fixture (${reopen ? 2 : 1}).mp4`);
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', item.filename], { encoding: 'utf8' }));
      assert.deepEqual(probe.streams.map(track => track.codec_name), ['h264', 'aac']); assert.equal(probe.streams[0].height, 720);
      assert.ok(Math.abs(Number(probe.format.duration) - 1.2) < 0.1);
      execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', item.filename, '-f', 'null', '-'], { stdio: 'pipe' });
      await sleep(600);
      const settled = await snapshot(); assert.equal(settled.jobs.length, after.jobs.length); assert.equal(settled.saves.length, after.saves.length);
      report.cases.push({ id: reopen ? 'reopen-explicit-same-selection-new-intent' : 'explicit-same-selection-new-intent', buttonState, priorRequestId: previous.requestId,
        job: repeated, browser: item, beforeJobs: before.jobs.length, afterJobs: after.jobs.length, beforeSaves: before.saves.length, afterSaves: after.saves.length,
        idleStable: true, decode: 'ffmpeg -xerror exit 0', probe: { duration: probe.format.duration, codecs: probe.streams.map(track => track.codec_name), height: probe.streams[0].height },
        screenshot: await capture(reopen ? '05-reopened-repeat' : '04-download-again') });
      previous = repeated;
    }
  }
  report.ok = true;
} catch (error) { report.ok = false; report.errors.push(String(error.stack || error)); process.exitCode = 1; }
finally {
  for (const target of targets) target.close();
  await context?.close(); for (const timer of timers) clearInterval(timer); for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
  report.closedOwnedBrowserAndServer = true;
  await writeFile(path.join(output, 'evidence.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, cases: report.cases.map(item => item.id), errors: report.errors, evidence: path.join(output, 'evidence.json') }));
}
