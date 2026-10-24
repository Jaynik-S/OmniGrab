// Independent, bounded source-tail comparison; never repeats the full download.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { chromium } from 'playwright-core';
const execute = promisify(execFile), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const run = path.resolve(process.argv[2]), saved = path.resolve(process.argv[3]);
const output = path.join(run, 'source-tail'); await mkdir(output, { recursive: true });
const original = JSON.parse(await readFile(path.join(run, 'receipt.json'), 'utf8'));
const selected = original.selectedManifests.selected;
const urls = selected.text.split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => new URL(line, selected.url).href);
const init = new URL(/#EXT-X-MAP:URI="([^"]+)"/.exec(selected.text)[1], selected.url).href;
const report = { started: new Date().toISOString(), scope: 'Fresh ordinary page-CORS init + final two fragments; compare final AAC packet payload hashes/timestamps, not an entire new source download or human listening', objects: [], commands: [], errors: [] };
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? 'C:/Users/jay03/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe', headless: true });
  const page = await browser.newPage(); await page.goto(original.target, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { document.addEventListener('play', e => { if (e.target instanceof HTMLMediaElement) e.target.pause(); }, true); for (const v of document.querySelectorAll('video')) v.pause(); });
  const fetchSmall = async (url, limit) => {
    const result = await page.evaluate(async ({ url, limit }) => {
      const r = await fetch(url, { mode: 'cors', credentials: 'same-origin', signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw Error('source HTTP ' + r.status);
      const reader = r.body.getReader(), chunks = []; let size = 0;
      try { for (;;) { const p = await reader.read(); if (p.done) break; size += p.value.length; if (size > limit) throw Error('bounded tail object exceeded'); chunks.push(p.value); } }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      let binary = ''; for (const chunk of chunks) for (let i = 0; i < chunk.length; i += 8192) binary += String.fromCharCode(...chunk.subarray(i, i + 8192));
      return { status: r.status, bytes: size, base64: btoa(binary) };
    }, { url, limit });
    const bytes = Buffer.from(result.base64, 'base64'); assert.equal(bytes.length, result.bytes);
    report.objects.push({ urlSha256: hash(url), status: result.status, bytes: bytes.length, sha256: hash(bytes) }); return bytes;
  };
  const fresh = await fetchSmall(selected.url, 2 * 1024 * 1024); assert.equal(hash(fresh), hash(selected.text), 'selected manifest changed');
  const pieces = []; for (const url of [init, ...urls.slice(-2)]) pieces.push(await fetchSmall(url, 8 * 1024 * 1024));
  const tail = path.join(output, 'source-tail.mp4'); await writeFile(tail, Buffer.concat(pieces));
  const packets = async (filename, interval) => {
    const args = ['-v', 'error', ...(interval ? ['-read_intervals', interval] : []), '-select_streams', 'a:0', '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=pts_time,duration_time,size,data_hash', '-of', 'json', filename];
    const result = await execute('ffprobe', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    report.commands.push({ program: 'ffprobe', args, exitCode: 0, stderr: result.stderr }); return JSON.parse(result.stdout).packets;
  };
  const source = await packets(tail), destination = await packets(saved, '3175%');
  const count = Math.min(source.length, destination.length); assert.ok(count > 200);
  const a = source.slice(-count), b = destination.slice(-count);
  assert.deepEqual(a.map(p => [p.data_hash, p.size]), b.map(p => [p.data_hash, p.size]), 'final AAC payloads differ');
  const deltas = a.map((p, i) => Number(b[i].pts_time) - Number(p.pts_time));
  assert.ok(Math.max(...deltas) - Math.min(...deltas) < 0.00001, 'inconsistent tail alignment');
  report.comparison = { matchedPackets: count, sourceFirst: a[0], sourceLast: a.at(-1), savedFirst: b[0], savedLast: b.at(-1), timestampOffsetMin: Math.min(...deltas), timestampOffsetMax: Math.max(...deltas), payloadHashSequenceSha256: hash(a.map(p => p.data_hash).join('\n')) };
  report.ok = true;
} catch (error) { report.ok = false; report.errors.push(error.stack ?? String(error)); process.exitCode = 1; }
finally { await browser?.close(); report.ownedBrowserClosed = true; report.ended = new Date().toISOString(); await writeFile(path.join(output, 'comparison.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
