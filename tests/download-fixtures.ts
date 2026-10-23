import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { DownloadPlan, ResourceFetch, SeekableOutput } from '../src/downloads/model.ts';

export const scratch = resolve('.cache/download-engine');
export function fixtures() {
  mkdirSync(scratch, { recursive: true });
  for (const [name, size, audio, type] of [
    ['mux720', '1280x720', true, 'fmp4'], ['ts720', '1280x720', true, 'mpegts'], ['ts1080', '1920x1080', true, 'mpegts'],
    ['video1080', '1920x1080', false, 'fmp4'], ['silent720', '1280x720', false, 'fmp4'],
    ['audio', '', true, 'fmp4'], ['audio44', '', true, 'fmp4'],
  ] as const) {
    const directory = resolve(scratch, name);
    mkdirSync(directory, { recursive: true });
    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    if (size) args.push('-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=10:duration=1.2`);
    if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${name === 'audio44' ? 44100 : 48000}:duration=1.2`);
    if (size) args.push('-c:v', 'libx264', '-threads', '1', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-g', '4', '-bf', '2');
    if (audio) args.push('-c:a', 'aac', '-b:a', '64k', '-ac', name === 'audio44' ? '2' : '1');
    args.push('-f', 'hls', '-hls_time', '0.4', '-hls_playlist_type', 'vod', '-hls_segment_type', type,
      '-hls_segment_filename', resolve(directory, type === 'fmp4' ? 'part%d.m4s' : 'part%d.ts'), resolve(directory, 'list.m3u8'));
    execFileSync('ffmpeg', args, { cwd: directory, stdio: 'pipe' });
  }
}

/** Original valid media with an explicit configuration transition after its first fragment. */
export function mixedFixturePlan(kind: 'video' | 'audio' | 'ts-video'): DownloadPlan {
  if (kind === 'ts-video') {
    const plan = fixturePlan('ts720');
    plan.manifests[0]!.text = plan.manifests[0]!.text.replace('ts720/part1.ts', 'ts1080/part1.ts').replace('ts720/part2.ts', 'ts1080/part2.ts');
    plan.resources.push(...fixturePlan('ts1080').resources); return plan;
  }
  const plan = fixturePlan(kind === 'video' ? 'silent720' : 'video1080', true);
  const oldName = kind === 'video' ? 'silent720' : 'audio';
  const newName = kind === 'video' ? 'video1080' : 'audio44';
  const manifest = plan.manifests[kind === 'video' ? 0 : 1]!;
  manifest.text = manifest.text.replace(new RegExp(`#EXTINF:([^\\n]*)\\nhttps://fixture.test/${oldName}/part1\\.m4s`),
    `#EXT-X-MAP:URI="https://fixture.test/${newName}/init.mp4"\n#EXTINF:$1\nhttps://fixture.test/${newName}/part1.m4s`)
    .replace(`https://fixture.test/${oldName}/part2.m4s`, `https://fixture.test/${newName}/part2.m4s`);
  plan.resources.push(...readdirSync(resolve(scratch, newName)).filter(file => !file.endsWith('.m3u8'))
    .map(file => ({ url: `https://fixture.test/${newName}/${file}` })));
  return plan;
}

export function fixturePlan(name = 'mux720', externalAudio = false): DownloadPlan {
  const names = externalAudio ? [name, 'audio'] : [name];
  const base = 'https://fixture.test/';
  const manifests = names.map(n => ({ url: `${base}${n}/list.m3u8`, text: readFileSync(resolve(scratch, n, 'list.m3u8'), 'utf8')
    // FFmpeg rounds sub-second target durations to zero; use a valid ceiling in the plan.
    .replace('#EXT-X-TARGETDURATION:0', '#EXT-X-TARGETDURATION:1')
    .replace(/URI="([^"]+)"/g, (_, uri) => `URI="${base}${n}/${uri}"`)
    .replace(/^(?!#)(\S+)$/gm, (_, uri) => `${base}${n}/${uri}`) }));
  return { selection: { tabId: 1, epoch: 1, mediaId: 'source', instance: 1, pageUrl: 'https://page.test/',
    frameId: 0, documentId: 'doc', sourceUrl: `${base}master.m3u8`, videoUrl: manifests[0]!.url,
    ...(externalAudio ? { audioUrl: manifests[1]!.url } : {}), width: name.includes('1080') ? 1920 : 1280,
    height: name.includes('1080') ? 1080 : 720, filename: 'output.mp4', output: 'mp4' },
    duration: 1.2, manifests, resources: names.flatMap(n => readdirSync(resolve(scratch, n))
      .filter(file => !file.endsWith('.m3u8')).map(file => ({ url: `${base}${n}/${file}` }))) };
}

export const fixtureFetch: ResourceFetch = async (input, init) => {
  init?.signal?.throwIfAborted();
  const url = new URL(input instanceof Request ? input.url : String(input));
  const data = readFileSync(resolve(scratch, '.' + url.pathname));
  const match = /^bytes=(\d+)-(\d*)$/.exec(new Headers(init?.headers).get('Range') ?? '');
  const start = match ? Number(match[1]) : 0;
  const end = match?.[2] ? Math.min(Number(match[2]), data.length - 1) : data.length - 1;
  return new Response(data.subarray(start, end + 1), { status: match ? 206 : 200,
    headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(end - start + 1),
      ...(match ? { 'Content-Range': `bytes ${start}-${end}/${data.length}` } : {}) } });
};

export class MemoryOutput implements SeekableOutput {
  bytes = new Uint8Array(0); closed = false; flushed = false;
  async write(data: Uint8Array, position: number) {
    assertOpen(this.closed);
    if (position + data.length > this.bytes.length) { const next = new Uint8Array(position + data.length); next.set(this.bytes); this.bytes = next; }
    this.bytes.set(data, position);
  }
  async flush() { this.flushed = true; }
  async close() { this.closed = true; }
}
function assertOpen(closed: boolean) { if (closed) throw new Error('Output closed'); }
