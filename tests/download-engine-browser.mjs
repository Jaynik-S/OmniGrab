// Isolated native engine proof. No extension state or real Chrome download claim.
// Run: node --experimental-strip-types tests/download-engine-browser.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { fixtures, fixturePlan, scratch } from './download-fixtures.ts';

fixtures();
const bundle = await build({ stdin: { contents: `
  import { remuxToMp4 } from './src/downloads/remux.ts';
  import { createOpfsOutput } from './src/downloads/opfs.ts';
  self.onmessage = async ({ data }) => {
    try {
      const directory = await navigator.storage.getDirectory();
      const patch = await createOpfsOutput(directory, 'patch.bin');
      await patch.write(Uint8Array.of(1,2,3), 0); await patch.write(Uint8Array.of(9), 1);
      await patch.flush(); await patch.close();
      const patched = [...new Uint8Array(await (await (await directory.getFileHandle('patch.bin')).getFile()).arrayBuffer())];
      const output = await createOpfsOutput(directory, data.name + '.mp4');
      const phases = []; let fetched = 0; let written = 0; let patches = 0; let highWater = 0;
      const write = output.write.bind(output);
      output.write = async (bytes, position) => { if(position < highWater) patches++; await write(bytes, position); written += bytes.length; highWater = Math.max(highWater, position + bytes.length); };
      const result = await remuxToMp4(data.plan, { output, fetcher: fetch,
        signal: new AbortController().signal,
        onProgress: p => { fetched = p.inputBytes; if(phases.at(-1) !== p.phase) phases.push(p.phase); } });
      const file = await (await directory.getFileHandle(data.name + '.mp4')).getFile();
      const bytes = await file.arrayBuffer();
      self.postMessage({ result, bytes, patched, phases, fetched, written, patches, fileSize: file.size }, [bytes]);
    } catch(error) { self.postMessage({ error: error.stack || String(error) }); }
  };
`, resolveDir: resolve('.'), sourcefile: 'native-engine-worker.ts', loader: 'ts' },
  bundle: true, platform: 'browser', format: 'esm', write: false, target: 'chrome120' });

const sample = resolve('.superpowers/cinejoy-init-and-first-segment.mp4');
let requests = 0; let served = 0;
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Native engine proof</title>'); return; }
  if (path === '/worker.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0].contents); return; }
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
  response.end(bytes.subarray(start, end + 1));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || 'C:/Users/jay03/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe', headless: true });
  console.log('Chromium', browser.version(), 'native dedicated-worker OPFS sync handles');
  const page = await browser.newPage(); await page.goto(origin);
  const cases = ['mux720', 'ts720', 'video1080'];
  if (existsSync(sample)) cases.push('captured');
  const evidence = [];
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
  writeFileSync(resolve(scratch, 'native-evidence.json'), JSON.stringify(evidence, null, 2));
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
