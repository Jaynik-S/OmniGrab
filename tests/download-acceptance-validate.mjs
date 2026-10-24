// Independent validation of the entire saved output; never loads the whole file into RAM.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { chromium } from 'playwright-core';
const execute = promisify(execFile);
const filename = path.resolve(process.argv[2] ?? '.superpowers/download-acceptance/cinejoy-1080p.mp4');
const output = path.resolve(process.argv[3] ?? '.superpowers/download-acceptance/validation');
await mkdir(output, { recursive: true });
const report = { filename, started: new Date().toISOString(), commands: [], playback: [], audio: [], errors: [] };
let browser, server; const sockets = new Set();
async function command(program, args, binary = false) {
  const record = { program, args, started: new Date().toISOString() }; report.commands.push(record);
  try { const result = await execute(program, args, { encoding: binary ? 'buffer' : 'utf8', maxBuffer: 4 * 1024 * 1024 }); record.exitCode = 0; record.stderr = result.stderr.toString(); return result.stdout; }
  catch (error) { record.exitCode = error.code; record.stderr = error.stderr?.toString(); throw error; }
  finally { record.ended = new Date().toISOString(); await writeFile(path.join(output, 'validation.json'), JSON.stringify(report, null, 2)); }
}
try {
  const metadata = await stat(filename); report.size = metadata.size;
  const hash = createHash('sha256'); for await (const chunk of createReadStream(filename)) hash.update(chunk); report.sha256 = hash.digest('hex');
  report.probe = JSON.parse(await command('ffprobe', ['-v', 'error', '-count_packets', '-show_streams', '-show_format', '-of', 'json', filename]));
  const video = report.probe.streams.find(t => t.codec_type === 'video'), audio = report.probe.streams.find(t => t.codec_type === 'audio');
  assert.equal(video.codec_name, 'h264'); assert.equal(video.width, 1920); assert.equal(video.height, 1080);
  assert.equal(audio.codec_name, 'aac'); assert.equal(audio.channels, 2);
  assert.ok(Math.abs(Number(report.probe.format.duration) - 3189.561635) < 2);
  assert.ok(Number(video.nb_read_packets) > 70000); assert.ok(Number(audio.nb_read_packets) > 100000);
  console.log(JSON.stringify({ fullProbe: true, bytes: report.size, sha256: report.sha256, videoPackets: video.nb_read_packets, audioPackets: audio.nb_read_packets, duration: report.probe.format.duration }));
  await command('ffmpeg', ['-v', 'error', '-xerror', '-i', filename, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
  report.fullDecodePassed = true; console.log('Full independent video and audio decode passed with -xerror');
  // Include the near-end program audio separately from a potentially quiet final tail.
  const times = [1, Number(report.probe.format.duration) / 2, Number(report.probe.format.duration) - 60, Number(report.probe.format.duration) - 4];
  for (const time of times) {
    const pcm = await command('ffmpeg', ['-v', 'error', '-xerror', '-ss', String(time), '-i', filename, '-t', '2', '-map', '0:a:0', '-f', 'f32le', '-acodec', 'pcm_f32le', '-'], true);
    let square = 0, peak = 0, nonzero = 0;
    for (let i = 0; i < pcm.length; i += 4) { const value = pcm.readFloatLE(i); assert.ok(Number.isFinite(value)); square += value * value; peak = Math.max(peak, Math.abs(value)); if (Math.abs(value) > 0.00001) nonzero++; }
    const channels = [0, 1].map(channel => {
      let sum = 0, peak = 0, nonzero = 0, samples = 0;
      for (let i = channel * 4; i < pcm.length; i += 8) { const v = pcm.readFloatLE(i); sum += v * v; peak = Math.max(peak, Math.abs(v)); nonzero += Math.abs(v) > 0.00001; samples++; }
      return { channel, samples, rms: Math.sqrt(sum / samples), peak, nonzero };
    });
    const result = { time, samples: pcm.length / 4, rms: Math.sqrt(square / (pcm.length / 4)), peak, nonzero, channels };
    assert.ok(result.samples > 10000); assert.ok(result.nonzero > 100);
    if (time !== times.at(-1)) for (const channel of channels) assert.ok(channel.rms > 0.0001 && channel.nonzero > 100, 'non-silent signal in each stereo channel');
    report.audio.push(result);
  }
  const requests = []; report.playbackRequests = requests;
  server = createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Independent saved-file playback</title><video controls muted width="960" src="/saved.mp4"></video>'); return; }
    if (req.url !== '/saved.mp4') { res.writeHead(404).end(); return; }
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    const start = match ? Number(match[1]) : 0, end = match?.[2] ? Math.min(Number(match[2]), metadata.size - 1) : metadata.size - 1;
    requests.push({ method: req.method, range: req.headers.range, start, end });
    if (start > end || start >= metadata.size) { res.writeHead(416, { 'content-range': `bytes */${metadata.size}` }).end(); return; }
    res.writeHead(match ? 206 : 200, { 'content-type': 'video/mp4', 'content-length': end - start + 1, 'accept-ranges': 'bytes', ...(match ? { 'content-range': `bytes ${start}-${end}/${metadata.size}` } : {}) });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = createReadStream(filename, { start, end, highWaterMark: 65536 }); stream.pipe(res); res.once('close', () => stream.destroy()); stream.on('error', error => res.destroy(error));
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? 'C:/Users/jay03/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe', headless: true });
  const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}`);
  for (const time of times) {
    const result = await page.evaluate(async time => {
      const v = document.querySelector('video');
      if (!v.readyState) await new Promise((resolve, reject) => { v.addEventListener('loadedmetadata', resolve, { once: true }); v.addEventListener('error', () => reject(Error(v.error?.message)), { once: true }); });
      await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('seek timeout')), 20000); v.addEventListener('seeked', () => { clearTimeout(timer); resolve(); }, { once: true }); v.currentTime = time; });
      const read = () => ({ currentTime: v.currentTime, frames: v.getVideoPlaybackQuality().totalVideoFrames, audioBytes: v.webkitAudioDecodedByteCount, videoBytes: v.webkitVideoDecodedByteCount });
      const before = read(); await v.play(); await new Promise(resolve => setTimeout(resolve, 1500)); v.pause();
      return { requested: time, before, after: read(), width: v.videoWidth, height: v.videoHeight, muted: v.muted, error: v.error?.message ?? null };
    }, time);
    assert.equal(result.error, null); assert.equal(result.width, 1920); assert.equal(result.height, 1080);
    assert.ok(Math.abs(result.before.currentTime - time) < 0.15); assert.ok(result.after.currentTime - result.before.currentTime > 0.5);
    assert.ok(result.after.frames > result.before.frames); assert.ok(result.after.audioBytes > result.before.audioBytes);
    report.playback.push(result); await page.screenshot({ path: path.join(output, `playback-${report.playback.length}.png`) });
  }
  report.ok = true;
} catch (error) { report.errors.push(error.stack ?? String(error)); report.ok = false; process.exitCode = 1; }
finally {
  await browser?.close(); for (const socket of sockets) socket.destroy(); if (server) await new Promise(resolve => server.close(resolve));
  report.ended = new Date().toISOString(); await writeFile(path.join(output, 'validation.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, output, errors: report.errors }));
}
