// Isolated native engine proof. No extension state or real Chrome download claim.
// Run: node --experimental-strip-types tests/download-engine-browser.mjs
// Focused held-preflight progress + cancellation: add --progress-only (generated media only).
// Gate cleanup controls: --progress-only --pre-gate-failure or --progress-only --gate-timeout.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { fixtures, fixturePlan, mixedFixturePlan, scratch } from './download-fixtures.ts';

const cacheOnly = process.argv.includes('--cache-only');
const progressOnly = process.argv.includes('--progress-only');
const preGateFailure = process.argv.includes('--pre-gate-failure');
const gateTimeout = process.argv.includes('--gate-timeout');
assert.ok(!(preGateFailure && gateTimeout) && (!(preGateFailure || gateTimeout) || progressOnly), 'use one gate fault with --progress-only');
mkdirSync(scratch, { recursive: true });
if (!cacheOnly && (!progressOnly || !existsSync(resolve(scratch, 'ts720/list.m3u8')))) fixtures();
const bundle = await build({ stdin: { contents: `
  import { remuxToMp4 } from './src/downloads/remux.ts';
  import { createOpfsOutput } from './src/downloads/opfs.ts';
  import { RemuxSourceAdapter } from './src/downloads/remux-source.ts';
  self.onmessage = async ({ data }) => {
    try {
      if (data.preGateFailure) throw new Error('controlled-pre-gate-failure');
      if (data.cacheCase) {
        let received = 0;
        const source = new RemuxSourceAdapter(data.plan, fetch, new AbortController().signal, bytes => { received += bytes; });
        try {
          const values = []; const ranges = [];
          for (const offset of [0, 262144, 262144]) {
            const response = await source.fetch(data.url, { headers: { Range: 'bytes=' + offset + '-' + offset } });
            ranges.push(response.headers.get('Content-Range'));
            values.push(...new Uint8Array(await response.arrayBuffer()));
          }
          self.postMessage({ values, ranges, received });
        } finally { source.dispose(); }
        return;
      }
      const directory = await navigator.storage.getDirectory();
      const patch = await createOpfsOutput(directory, 'patch.bin');
      await patch.write(Uint8Array.of(1,2,3), 0); await patch.write(Uint8Array.of(9), 1);
      await patch.flush(); await patch.close();
      const patched = [...new Uint8Array(await (await (await directory.getFileHandle('patch.bin')).getFile()).arrayBuffer())];
      const output = await createOpfsOutput(directory, data.name + '.mp4');
      if (data.progressCase) {
        const controller = new AbortController();
        self.onmessage = () => controller.abort();
        try {
          await remuxToMp4(data.plan, { output, fetcher: fetch, signal: controller.signal,
            onProgress: progress => self.postMessage({ type: 'progress', progress }) });
          throw new Error('Pending preflight unexpectedly completed');
        } catch (error) {
          if (error.name !== 'AbortError') throw error;
          const file = await directory.getFileHandle(data.name + '.mp4');
          const handle = await file.createSyncAccessHandle(); handle.close();
          const closedSize = (await file.getFile()).size;
          await directory.removeEntry(data.name + '.mp4');
          const remaining = []; for await (const name of directory.keys()) remaining.push(name);
          self.postMessage({ type: 'aborted', closedSize, removed: !remaining.includes(data.name + '.mp4') });
        }
        return;
      }
      const phases = []; let fetched = 0; let written = 0; let patches = 0; let highWater = 0;
      const write = output.write.bind(output);
      output.write = async (bytes, position) => { if(position < highWater) patches++; await write(bytes, position); written += bytes.length; highWater = Math.max(highWater, position + bytes.length); };
      const result = await remuxToMp4(data.plan, { output, fetcher: fetch,
        signal: new AbortController().signal,
        onProgress: p => { fetched = p.inputBytes; if(phases.at(-1) !== p.phase) phases.push(p.phase); } });
      const file = await (await directory.getFileHandle(data.name + '.mp4')).getFile();
      const bytes = await file.arrayBuffer();
      self.postMessage({ result, bytes, patched, phases, fetched, written, patches, fileSize: file.size }, [bytes]);
    } catch(error) {
      let closedSize;
      if (data.rejectCase) {
        const directory = await navigator.storage.getDirectory();
        const file = await directory.getFileHandle(data.name + '.mp4');
        // Acquiring a second exclusive native handle proves the failed engine closed its handle.
        const handle = await file.createSyncAccessHandle(); handle.close();
        closedSize = (await file.getFile()).size;
      }
      self.postMessage({ error: error.stack || String(error), closedSize });
    }
  };
`, resolveDir: resolve('.'), sourcefile: 'native-engine-worker.ts', loader: 'ts' },
  bundle: true, platform: 'browser', format: 'esm', write: false, target: 'chrome120' });

const sample = resolve('.superpowers/cinejoy-init-and-first-segment.mp4');
let requests = 0; let served = 0;
let progressRun = false; let progressGate;
let heldResponse; let preflightServed = 0;
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Native engine proof</title>'); return; }
  if (path === '/worker.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0].contents); return; }
  if (path === '/cache-object.bin') {
    const bytes = new Uint8Array(130 * 256 * 1024); bytes[256 * 1024] = 91;
    requests++; served += bytes.length;
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length });
    response.end(bytes); return;
  }
  const filename = path === '/captured.mp4' ? sample : resolve(scratch, '.' + path);
  const rel = relative(scratch, filename);
  if (filename !== sample && (rel.startsWith('..' + sep) || rel === '..')) { response.writeHead(403).end(); return; }
  if (!existsSync(filename)) { response.writeHead(404).end(); return; }
  const bytes = readFileSync(filename);
  const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
  const start = match ? Number(match[1]) : 0;
  const end = match?.[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
  if (start > end) { response.writeHead(416).end(); return; }
  requests++; served += end - start + 1;
  response.writeHead(match ? 206 : 200, { 'Content-Type': 'image/jpeg', 'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1, ...(match ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) });
  if (progressRun && path === '/ts720/part1.ts') {
    preflightServed = served - (end - start + 1) + 64;
    heldResponse = response; response.write(bytes.subarray(start, start + 64)); if (!gateTimeout) progressGate(); return;
  }
  response.end(bytes.subarray(start, end + 1));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || 'C:/Users/jay03/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe', headless: true });
  console.log('Chromium', browser.version(), 'native dedicated-worker OPFS sync handles');
  const page = await browser.newPage(); await page.goto(origin);
  const cases = cacheOnly || progressOnly ? [] : ['mux720', 'ts720', 'video1080'];
  if (!cacheOnly && !progressOnly && existsSync(sample)) cases.push('captured');
  const evidence = [];
  if (progressOnly) {
    progressRun = true;
    const gate = new Promise(resolve => { progressGate = resolve; });
    const plan = JSON.parse(JSON.stringify(fixturePlan('ts720')).replaceAll('https://fixture.test', origin));
    await page.evaluate(({ plan, preGateFailure }) => {
      const worker = new Worker('/worker.js', { type: 'module' });
      const state = { worker, progress: [] }; globalThis.progressControl = state;
      state.result = new Promise((resolve, reject) => {
        worker.onerror = error => reject(new Error(error.message));
        worker.onmessage = ({ data }) => {
          if (data.type === 'progress') state.progress.push(data.progress);
          else if (data.error) reject(new Error(data.error));
          else resolve(data);
        };
      });
      state.result.catch(() => {}); // Observe a failure even before Node starts awaiting the gate race.
      worker.postMessage({ name: 'preflight-progress', plan, progressCase: true, preGateFailure });
    }, { plan, preGateFailure });
    let snapshot; let cleanup; let gateError; let gateTimer;
    try {
      await Promise.race([
        gate,
        page.evaluate(async () => {
          await globalThis.progressControl.result;
          throw new Error('Worker completed before the held-request gate');
        }),
        new Promise((_, reject) => { gateTimer = setTimeout(() => reject(new Error('held-request-gate-timeout')), gateTimeout ? 1000 : 5000); }),
      ]);
      clearTimeout(gateTimer);
      await page.waitForFunction(bytes => globalThis.progressControl.progress.at(-1)?.inputBytes === bytes,
        preflightServed, { timeout: 5000 });
      snapshot = await page.evaluate(() => globalThis.progressControl.progress.at(-1));
      assert.equal(snapshot.phase, 'processing'); assert.equal(snapshot.outputBytes, 0); assert.equal(snapshot.seconds, 0);
      assert.ok(snapshot.inputBytes > 64, 'progress must include previous media plus the held later segment');
    } catch (error) {
      gateError = error;
    } finally {
      clearTimeout(gateTimer);
      try {
        cleanup = await page.evaluate(async () => {
          const state = globalThis.progressControl; let timer;
          try {
            state.worker.postMessage({ abort: true });
            return await Promise.race([state.result, new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('held-worker-cleanup-timeout')), 5000);
            })]);
          } catch (error) { return { type: 'cleanup-error', error: String(error) }; }
          finally { clearTimeout(timer); state.worker.terminate(); state.terminated = true; }
        });
      } finally { heldResponse?.destroy(); }
    }
    const workerTerminated = await page.evaluate(() => globalThis.progressControl.terminated);
    assert.equal(workerTerminated, true);
    if (preGateFailure) {
      assert.match(String(gateError), /controlled-pre-gate-failure/);
      assert.equal(cleanup.type, 'cleanup-error'); assert.match(cleanup.error, /controlled-pre-gate-failure/);
      assert.equal(heldResponse, undefined); assert.equal(requests, 0);
    } else {
      assert.equal(cleanup.type, 'aborted'); assert.equal(cleanup.closedSize, 0); assert.equal(cleanup.removed, true);
      assert.equal(heldResponse?.destroyed, true);
      if (gateTimeout) assert.match(String(gateError), /held-request-gate-timeout/);
      else if (gateError) throw gateError;
    }
    evidence.push({ name: preGateFailure ? 'pre-gate-worker-failure' : gateTimeout ? 'held-request-gate-timeout' : 'pending-preflight-input-progress', snapshot, preflightServed, cleanup,
      gateError: gateError ? String(gateError) : undefined, workerTerminated, heldResponseDestroyed: heldResponse?.destroyed ?? null,
      requests, native: preGateFailure ? 'controlled dedicated-worker failure before OPFS file creation' : 'dedicated-worker fetch + OPFS sync handle reacquired and temporary file removed' });
    console.log(JSON.stringify(evidence.at(-1)));
  }
  for (const name of cases) {
    requests = 0; served = 0;
    let plan;
    if (name === 'captured') {
      const url = origin + '/captured.mp4';
      plan = fixturePlan('video1080'); plan.duration = 7.957333;
      plan.selection.videoUrl = origin + '/captured.m3u8';
      plan.manifests = [{ url: plan.selection.videoUrl, text: `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:8\n#EXT-X-MAP:URI="${url}",BYTERANGE="1393@0"\n#EXTINF:7.957333,\n#EXT-X-BYTERANGE:3274899@1393\n${url}\n#EXT-X-ENDLIST` }];
      plan.resources = [{ url, range: { start: 0, end: 1392 } }, { url, range: { start: 1393, end: 3276291 } }];
    } else {
      plan = JSON.parse(JSON.stringify(fixturePlan(name, name === 'video1080')).replaceAll('https://fixture.test', origin));
    }
    const result = await page.evaluate(({ name, plan }) => new Promise((resolve, reject) => {
      const worker = new Worker('/worker.js', { type: 'module' });
      worker.onerror = error => { worker.terminate(); reject(new Error(error.message)); };
      worker.onmessage = ({ data }) => {
        worker.terminate();
        if (data.error) reject(new Error(data.error));
        else { const { bytes, ...metadata } = data; resolve({ ...metadata, bytes: Array.from(new Uint8Array(bytes)) }); }
      };
      worker.postMessage({ name, plan });
    }), { name, plan });
    assert.deepEqual(result.patched, [1, 9, 3]);
    assert.equal(result.fileSize, result.result.bytes);
    assert.ok(result.patches > 0, 'muxer must perform native backward header patches');
    assert.deepEqual(result.phases, ['processing', 'finalizing']);
    const filename = resolve(scratch, `native-${name}.mp4`); writeFileSync(filename, Uint8Array.from(result.bytes));
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filename], { encoding: 'utf8' }));
    assert.deepEqual(probe.streams.map(track => track.codec_name), ['h264', 'aac']);
    assert.equal(probe.streams[0].height, name === 'captured' || name === 'video1080' ? 1080 : 720);
    execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', filename, '-f', 'null', '-'], { stdio: 'pipe' });
    const { bytes, ...metadata } = result;
    evidence.push({ name, ...metadata, requests, served, probe: { duration: probe.format.duration,
      tracks: probe.streams.map(t => ({ codec: t.codec_name, width: t.width, height: t.height, channels: t.channels,
        sampleRate: t.sample_rate, frames: t.nb_frames, duration: t.duration })) }, decode: 'ffmpeg -xerror exit 0' });
    console.log(JSON.stringify(evidence.at(-1)));
  }
  for (const kind of cacheOnly || progressOnly ? [] : ['video', 'audio', 'ts-video']) {
    requests = 0; served = 0;
    const name = 'reject-' + kind;
    const plan = JSON.parse(JSON.stringify(mixedFixturePlan(kind)).replaceAll('https://fixture.test', origin));
    const result = await page.evaluate(({ name, plan }) => new Promise((resolve, reject) => {
      const worker = new Worker('/worker.js', { type: 'module' });
      worker.onerror = error => { worker.terminate(); reject(new Error(error.message)); };
      worker.onmessage = ({ data }) => { worker.terminate(); resolve(data); };
      worker.postMessage({ name, plan, rejectCase: true });
    }), { name, plan });
    assert.match(result.error || '', /configuration|dimensions|change/i);
    assert.equal(result.closedSize, 0, 'configuration changes must reject before mux output and release the native handle');
    evidence.push({ name, error: result.error.split('\n')[0], closedSize: result.closedSize, requests, served });
    console.log(JSON.stringify(evidence.at(-1)));
  }
  if (!progressOnly) {
  requests = 0; served = 0;
  const url = origin + '/cache-object.bin';
  const cachePlan = { selection: { tabId: 1, epoch: 1, mediaId: 'cache', instance: 1, pageUrl: origin,
    frameId: 0, documentId: 'cache-doc', sourceUrl: origin + '/cache.m3u8', videoUrl: origin + '/cache.m3u8', filename: 'cache.mp4', output: 'mp4' },
    manifests: [], resources: [{ url }] };
  const cacheResult = await page.evaluate(({ url, plan }) => new Promise((resolve, reject) => {
    const worker = new Worker('/worker.js', { type: 'module' });
    worker.onerror = error => { worker.terminate(); reject(new Error(error.message)); };
    worker.onmessage = ({ data }) => { worker.terminate(); if(data.error) reject(new Error(data.error)); else resolve(data); };
    worker.postMessage({ url, plan, cacheCase: true });
  }), { url, plan: cachePlan });
  assert.deepEqual(cacheResult.values, [0, 91, 91]);
  assert.deepEqual(cacheResult.ranges, ['bytes 0-0/34078720', 'bytes 262144-262144/34078720', 'bytes 262144-262144/34078720']);
  assert.equal(requests, 2); assert.equal(cacheResult.received, 68157440);
  evidence.push({ name: 'range-ignoring-eviction', ...cacheResult, requests, served });
  console.log(JSON.stringify(evidence.at(-1)));
  }
  writeFileSync(resolve(scratch, progressOnly ? preGateFailure ? 'native-progress-pre-gate-failure-evidence.json' : gateTimeout ? 'native-progress-gate-timeout-evidence.json' : 'native-progress-evidence.json' : cacheOnly ? 'native-cache-evidence.json' : 'native-evidence.json'), JSON.stringify(evidence, null, 2));
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
