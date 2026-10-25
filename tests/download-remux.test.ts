import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { writeFileSync, statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixtureFetch, fixturePlan, fixtures, MemoryOutput, mixedFixturePlan, scratch } from './download-fixtures.ts';
import { EncodedPacketSink } from 'mediabunny';
import { prepareSegmentValidation } from '../src/downloads/remux-validation.ts';
import { remuxToMp4 } from '../src/downloads/remux.ts';
import { RemuxSourceAdapter } from '../src/downloads/remux-source.ts';
import type { RemuxProgress, ResourceFetch } from '../src/downloads/model.ts';

before(fixtures);
for (const [name, external] of [['mux720', false], ['ts720', false], ['video1080', true]] as const) {
  test(`packet remux preserves ${name} selected video and audible AAC with independent decode`, async () => {
    const output = new MemoryOutput();
    const progress: Array<{inputBytes: number; outputBytes: number}> = [];
    const result = await remuxToMp4(fixturePlan(name, external), { fetcher: fixtureFetch, output,
      signal: new AbortController().signal, onProgress: p => progress.push(p) });
    assert.equal(result.video.height, external ? 1080 : 720);
    assert.equal(result.audio.codec, 'aac');
    assert.ok(output.closed && output.flushed);
    assert.equal(result.bytes, output.bytes.length);
    assert.ok(progress.at(-1)!.inputBytes > 1000);
    assert.equal(progress.at(-1)!.outputBytes, result.bytes);
    const path = resolve(scratch, `${name}-output.mp4`); writeFileSync(path, output.bytes);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], { encoding: 'utf8' }));
    assert.deepEqual(probe.streams.map((s: {codec_name: string}) => s.codec_name), ['h264', 'aac']);
    assert.equal(probe.streams[0].height, external ? 1080 : 720);
    assert.ok(Number(probe.format.duration) >= 1.19);
    execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', path, '-f', 'null', '-'], { stdio: 'pipe' });
    const frameHashes = (input: string) => execFileSync('ffmpeg', ['-v', 'error', '-i', input, '-map', '0:v:0', '-f', 'framemd5', '-'], { encoding: 'utf8' })
      .split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1)!.trim());
    assert.deepEqual(frameHashes(path), frameHashes(resolve(scratch, name, 'list.m3u8')), 'decoded pixels and frame order must survive packet remux');
  });
}

test('selected dimensions and mandatory audio reject before success and close the writer', async () => {
  for (const name of ['mux720', 'silent720']) {
    const plan = fixturePlan(name); if (name === 'mux720') plan.selection.height = 1080;
    const output = new MemoryOutput();
    await assert.rejects(remuxToMp4(plan, { fetcher: fixtureFetch, output, signal: new AbortController().signal }), /dimensions|audio/i);
    assert.ok(output.closed);
  }
});

for (const kind of ['video', 'audio', 'ts-video'] as const) {
  test(`rejects actual ${kind} decoder configuration changes in later HLS fragments`, async () => {
    const output = new MemoryOutput();
    await assert.rejects(remuxToMp4(mixedFixturePlan(kind), { fetcher: fixtureFetch, output, signal: new AbortController().signal }), /configuration|dimensions|change/i);
    assert.ok(output.closed);
    assert.equal(output.flushed, false);
  });
}

test('already aborted jobs close output without fetching media', async () => {
  const controller = new AbortController(); controller.abort(); const output = new MemoryOutput();
  await assert.rejects(remuxToMp4(fixturePlan(), { fetcher: async () => { throw new Error('Must not fetch'); }, output, signal: controller.signal }), { name: 'AbortError' });
  assert.ok(output.closed);
});

test('earlier validated segments reach MP4 output while the final fragment body is blocked', { timeout: 10_000 }, async () => {
  const controller = new AbortController(); const output = new MemoryOutput();
  const progress: RemuxProgress[] = [];
  let received = 0; let beforeLaterSegment = 0; let transportAborted = false;
  let reachedGate!: () => void;
  const gate = new Promise<void>(resolve => { reachedGate = resolve; });
  const pending = remuxToMp4(fixturePlan('ts720'), { output, signal: controller.signal,
    onProgress: value => progress.push(value),
    fetcher: async (input, init) => {
      const response = await fixtureFetch(input, init);
      if (!String(input).endsWith('/part2.ts')) {
        received += Number(response.headers.get('Content-Length')); return response;
      }
      beforeLaterSegment = received;
      const bytes = new Uint8Array(await response.arrayBuffer());
      let sent = false;
      return new Response(new ReadableStream<Uint8Array>({
        start(stream) {
          init!.signal!.addEventListener('abort', () => {
            transportAborted = true; stream.error(init!.signal!.reason);
          }, { once: true });
        },
        pull(stream) {
          if (!sent) { sent = true; received += 64; stream.enqueue(bytes.subarray(0, 64)); }
          else { reachedGate(); return new Promise(() => {}); }
        },
      }, { highWaterMark: 0 }), { status: response.status, headers: response.headers });
    } });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  try {
    await gate;
    assert.ok(progress.at(-1), 'input progress must arrive before later-segment validation finishes');
    assert.equal(progress.at(-1)!.inputBytes, received, 'report bytes actually consumed, including the incomplete response');
    assert.ok(progress.at(-1)!.inputBytes > beforeLaterSegment);
    assert.equal(progress.at(-1)!.phase, 'processing');
    for (let n = 0; n < 200 && !progress.some(value => value.outputBytes > 0 && (value.seconds ?? 0) > 0); n++)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(progress.some(value => value.outputBytes > 0 && (value.seconds ?? 0) > 0), 'earlier validated segments must reach MP4 output');
    assert.ok(output.bytes.length > 0); assert.equal(output.closed, false);
  } finally { controller.abort(); await rejected; }
  assert.equal(transportAborted, true); assert.equal(output.closed, true);
  assert.equal(output.flushed, false);
});

test('abort during an awaited disk write stops processing and closes output', async () => {
  const controller = new AbortController(); const output = new MemoryOutput();
  const write = output.write.bind(output);
  output.write = async (data, position) => { await write(data, position); controller.abort(); };
  await assert.rejects(remuxToMp4(fixturePlan(), { fetcher: fixtureFetch, output, signal: controller.signal }), { name: 'AbortError' });
  assert.ok(output.closed);
});

test('a short but well-formed rendition cannot satisfy the promised full duration', async () => {
  const plan = fixturePlan(); plan.duration = 20;
  const output = new MemoryOutput();
  await assert.rejects(remuxToMp4(plan, { fetcher: fixtureFetch, output, signal: new AbortController().signal }), /Truncated/);
  assert.ok(output.closed);
});

test('a two-frame duration deficit is rejected rather than hidden by a fixed quarter-second tolerance', async () => {
  const plan = fixturePlan(); plan.duration = 1.4;
  await assert.rejects(remuxToMp4(plan, { fetcher: fixtureFetch, output: new MemoryOutput(), signal: new AbortController().signal }), /Truncated/);
});

test('the engine never fetches resources absent from the grant list', async () => {
  const plan = fixturePlan(); plan.resources = [];
  const output = new MemoryOutput();
  await assert.rejects(remuxToMp4(plan, { fetcher: async () => { throw new Error('Must not fetch'); }, output, signal: new AbortController().signal }), /outside the download plan/);
  assert.ok(output.closed);
});

test('failed transport is not retried by the media library', async () => {
  let requests = 0; const output = new MemoryOutput();
  await assert.rejects(remuxToMp4(fixturePlan(), { fetcher: async () => { requests++; throw new Error('Network failure'); }, output, signal: new AbortController().signal }), /Network failure/);
  assert.equal(requests, 1);
  assert.ok(output.closed);
});

test('packet reads reuse a bounded shared range cache instead of refetching every segment for each packet', async () => {
  const plan = fixturePlan(); let transferred = 0;
  const output = new MemoryOutput();
  await remuxToMp4(plan, { output, signal: new AbortController().signal,
    fetcher: async (input, init) => { const response = await fixtureFetch(input, init); transferred += Number(response.headers.get('Content-Length')); return response; } });
  const payload = plan.resources.reduce((total, resource) => total + statSync(resolve(scratch, '.' + new URL(resource.url).pathname)).size, 0);
  assert.ok(transferred <= payload * 3, `media amplification ${transferred}/${payload}`);
});

test('shared range cache holds at most 32 MiB and evicts the least recently used actual block', async () => {
  const block = 4 * 1024 * 1024; const url = 'https://fixture.test/large.bin';
  const plan = fixturePlan(); plan.resources = [{ url }];
  let requests = 0;
  const source = new RemuxSourceAdapter(plan, async (_input, init) => {
    requests++;
    const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('Range')!)!;
    const start = Number(match[1]); const end = Number(match[2]);
    assert.equal(end - start + 1, block);
    return new Response(new Uint8Array(block).fill(start / block), { status: 206, headers: {
      'Content-Range': `bytes ${start}-${end}/${9 * block}`, 'Content-Length': String(block),
    } });
  }, new AbortController().signal, () => {});
  const read = async (index: number) => {
    const response = await source.fetch(url, { headers: { Range: `bytes=${index * block}-${index * block}` } });
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [index]);
  };
  try {
    for (let index = 0; index < 8; index++) await read(index);
    await read(0); assert.equal(requests, 8);
    await read(8); assert.equal(requests, 9);
    await read(1); assert.equal(requests, 10);
    await read(0); assert.equal(requests, 10);
    assert.equal(source.metrics.cachedBytes, 32 * 1024 * 1024);
    assert.equal(source.metrics.maximumCachedBytes, 32 * 1024 * 1024);
    assert.equal(source.metrics.maximumInFlightBytes, block);
  } finally { source.dispose(); }
  await source.settled(); assert.equal(source.metrics.cachedBytes, 0); assert.equal(source.metrics.active, 0);
  await assert.rejects(source.fetch(url, { headers: { Range: 'bytes=0-0' } }), /closed/);
});

test('block alignment respects inclusive MAP grants and preserves final URL and truthful response ranges', async () => {
  const url = 'https://fixture.test/signed.bin?sig=a%2Fb&x=2'; const plan = fixturePlan();
  plan.resources = [{ url, range: { start: 17, end: 27 } }];
  const source = new RemuxSourceAdapter(plan, async (_input, init) => {
    assert.equal(new Headers(init?.headers).get('Range'), 'bytes=17-27');
    const response = new Response(Uint8Array.from({ length: 11 }, (_, i) => i + 17), { status: 206,
      headers: { 'Content-Range': 'bytes 17-27/100', 'Content-Length': '11', 'Content-Type': 'image/jpeg' } });
    Object.defineProperties(response, { url: { value: 'https://cdn.test/final.bin?sig=a%2Fb' }, redirected: { value: true } });
    return response;
  }, new AbortController().signal, () => {});
  try {
    const response = await source.fetch(url, { headers: { Range: 'bytes=20-24' } });
    assert.equal(response.headers.get('Content-Range'), 'bytes 20-24/100');
    assert.equal(response.headers.get('Content-Length'), '5');
    assert.equal(response.url, 'https://cdn.test/final.bin?sig=a%2Fb'); assert.equal(response.redirected, true);
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [20, 21, 22, 23, 24]);
    await assert.rejects(source.fetch(url, { headers: { Range: 'bytes=16-16' } }), /outside/);
    await assert.rejects(source.fetch(url, { headers: { Range: 'bytes=28-28' } }), /outside/);
    await assert.rejects(source.fetch(url, { headers: { Range: 'bytes=20-19' } }), /range/);
  } finally { source.dispose(); }
});

test('complete range-ignoring objects are bounded and exposed as truthful virtual byte ranges', async () => {
  const url = 'https://fixture.test/object.bin'; const plan = fixturePlan(); plan.resources = [{ url }];
  let requests = 0;
  const source = new RemuxSourceAdapter(plan, async () => {
    requests++; return new Response(Uint8Array.of(1, 2, 3, 4), { headers: { 'Content-Length': '4' } });
  }, new AbortController().signal, () => {});
  try {
    let response = await source.fetch(url, { headers: { Range: 'bytes=0-0' } });
    assert.equal(response.status, 206); assert.equal(response.headers.get('Content-Range'), 'bytes 0-0/4');
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1]);
    response = await source.fetch(url, { headers: { Range: 'bytes=2-3' } });
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [3, 4]); assert.equal(requests, 1);
  } finally { source.dispose(); }
  const tooLarge = new RemuxSourceAdapter(plan, async () => new Response(Uint8Array.of(1), { headers: { 'Content-Length': String(64 * 1024 * 1024 + 1) } }), new AbortController().signal, () => {});
  try { await assert.rejects(tooLarge.fetch(url, { headers: { Range: 'bytes=0-0' } }), /ignored range/); }
  finally { tooLarge.dispose(); }
});

test('disposing source adapters aborts their pending transport operation', async () => {
  const url = 'https://fixture.test/pending.bin'; const plan = fixturePlan(); plan.resources = [{ url }];
  const source = new RemuxSourceAdapter(plan, async (_input, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
  }), new AbortController().signal, () => {});
  const pending = source.fetch(url, { headers: { Range: 'bytes=0-0' } }); source.dispose();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('range-ignoring objects remain seekable at a nonzero block after 32 MiB cache eviction', async () => {
  const block = 4 * 1024 * 1024; const length = 9 * block;
  const url = 'https://fixture.test/full-object.bin'; const plan = fixturePlan(); plan.resources = [{ url }];
  let requests = 0; const ranges: string[] = [];
  const source = new RemuxSourceAdapter(plan, async (_input, init) => {
    ranges.push(new Headers(init?.headers).get('Range')!);
    requests++; const bytes = new Uint8Array(length); bytes[block] = 91;
    return new Response(bytes, { headers: { 'Content-Length': String(length) } });
  }, new AbortController().signal, () => {});
  try {
    const first = await source.fetch(url, { headers: { Range: 'bytes=0-0' } });
    assert.deepEqual([...new Uint8Array(await first.arrayBuffer())], [0]);
    const second = await source.fetch(url, { headers: { Range: `bytes=${block}-${block}` } });
    assert.equal(second.headers.get('Content-Range'), `bytes ${block}-${block}/${length}`);
    assert.deepEqual([...new Uint8Array(await second.arrayBuffer())], [91]);
    assert.equal(requests, 2);
    assert.deepEqual(ranges, ['bytes=0-4194303', 'bytes=0-4194303']);
    const cached = await source.fetch(url, { headers: { Range: `bytes=${block}-${block}` } });
    assert.deepEqual([...new Uint8Array(await cached.arrayBuffer())], [91]); assert.equal(requests, 2);
    assert.equal(source.metrics.maximumCachedBytes, 32 * 1024 * 1024);
    assert.equal(source.metrics.maximumInFlightBytes, length);
  } finally { source.dispose(); }
  await source.settled(); assert.equal(source.metrics.inFlightBytes, 0);
});

test('truncated media cannot produce a successful MP4', async () => {
  const output = new MemoryOutput();
  await assert.rejects(remuxToMp4(fixturePlan(), { fetcher: async (input, init) => {
    const response = await fixtureFetch(input, init);
    if (String(input).includes('part2')) return new Response(new Uint8Array(20), { status: response.status, headers: response.headers });
    return response;
  }, output, signal: new AbortController().signal }));
  assert.ok(output.closed);
});

test('invalid response ranges and disk failure propagate and close output', async () => {
  for (const diskFailure of [false, true]) {
    const output = new MemoryOutput();
    if (diskFailure) output.write = async () => { throw new Error('Disk full'); };
    await assert.rejects(remuxToMp4(fixturePlan(), { fetcher: async (input, init) => {
      const response = await fixtureFetch(input, init);
      if (!diskFailure) response.headers.set('Content-Range', 'bytes 9-1/2');
      return response;
    }, output, signal: new AbortController().signal }), diskFailure ? /Disk full/ : /range/i);
    assert.ok(output.closed);
  }
});

test('flush failure rejects a completed mux and still closes the disk handle', async () => {
  const output = new MemoryOutput(); output.flush = async () => { throw new Error('Flush failed'); };
  await assert.rejects(remuxToMp4(fixturePlan(), { fetcher: fixtureFetch, output, signal: new AbortController().signal }), /Flush failed/);
  assert.ok(output.closed);
});

test('output quota failure survives remux cancellation and closes the writer', async () => {
  const { OpfsOutput } = await import('../src/downloads/opfs.ts');
  let closed = 0;
  const output = new OpfsOutput({ write() { throw new DOMException('private media URL', 'QuotaExceededError'); }, flush() {}, close() { closed++; } });
  await assert.rejects(remuxToMp4(fixturePlan(), { output, fetcher: fixtureFetch, signal: new AbortController().signal }), { message: 'download-storage-quota-exceeded' });
  assert.equal(closed, 1);
});

for (const failure of ['abort', 'disk-error'] as const) {
  test(`${failure} cleanup awaits asynchronous physical cancellation before closing the writer`, { timeout: 10_000 }, async () => {
    const controller = new AbortController(); const output = new MemoryOutput();
    let release!: () => void; let cancellationStarted!: () => void; let blocked!: () => void;
    const cancellation = new Promise<void>(resolve => { release = resolve; });
    const canceling = new Promise<void>(resolve => { cancellationStarted = resolve; });
    const pulling = new Promise<void>(resolve => { blocked = resolve; });
    if (failure === 'disk-error') output.write = async () => { throw new Error('Disk failed'); };
    let finished = false;
    const pending = remuxToMp4(fixturePlan('ts720'), { output, signal: controller.signal,
      fetcher: async (input, init) => {
        const response = await fixtureFetch(input, init);
        if (!String(input).endsWith('/part2.ts')) return response;
        return new Response(new ReadableStream<Uint8Array>({
          pull() { blocked(); return new Promise(() => {}); },
          cancel() { cancellationStarted(); return cancellation; },
        }, { highWaterMark: 0 }), { status: response.status, headers: response.headers });
      } });
    const rejected = assert.rejects(pending, failure === 'abort' ? { name: 'AbortError' } : /Disk failed/)
      .then(() => { finished = true; });
    try {
      await pulling;
      if (failure === 'abort') controller.abort();
      await canceling;
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(output.closed, false, 'writer must stay owned until physical cancellation settles');
      assert.equal(finished, false, 'job resources cannot be reused before cancellation settles');
    } finally { release(); await rejected; }
    assert.equal(output.closed, true);
    assert.equal(output.flushed, false);
  });
}

async function setup(plan = fixturePlan('ts720'), fetcher: ResourceFetch = fixtureFetch, signal = new AbortController().signal) {
  const source = new RemuxSourceAdapter(plan, fetcher, signal, () => {}, { prefetch: false });
  const input = source.open(plan.selection.videoUrl);
  const audioInput = plan.selection.audioUrl ? source.open(plan.selection.audioUrl) : input;
  const video = (await input.getPrimaryVideoTrack())!, audio = (await audioInput.getPrimaryAudioTrack())!;
  return { source, input, video, audio };
}

test('probe Inputs bypass only their own gate; concurrent ordinary Inputs remain gated and rejection propagates', async () => {
  const { source } = await setup(fixturePlan());
  let unblock!: () => void; let gated = 0;
  const block = new Promise<void>(resolve => { unblock = resolve; });
  source.setSegmentGate(async url => { assert.match(url, /part0.m4s$/); gated++; await block; throw new Error('Segment rejected'); });
  try {
    const main = source.open('https://fixture.test/mux720/list.m3u8');
    const pending = main.getPrimaryVideoTrack();
    const rejected = assert.rejects(pending, /Segment rejected/);
    const probe = source.open('https://fixture.test/mux720/list.m3u8', fixturePlan().manifests[0].text);
    assert.ok(await probe.getPrimaryVideoTrack(), 'probe must not recursively wait for its own gate');
    const second = source.open('https://fixture.test/mux720/list.m3u8');
    const secondRejected = assert.rejects(second.getPrimaryVideoTrack(), /Segment rejected/);
    for (let n = 0; n < 100 && gated < 2; n++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(gated, 2, 'ordinary Inputs must stay gated while a probe is alive');
    unblock(); await Promise.all([rejected, secondRejected]);
  } finally { unblock(); source.dispose(); await source.settled(); }
});

test('initial cached child is validated before preparation resolves and each later identity is probed once', async () => {
  const { source, input, video, audio } = await setup();
  const opened: string[] = [];
  const open = source.open.bind(source);
  source.open = (url, text) => { if (text) opened.push(text); return open(url, text); };
  try {
    await prepareSegmentValidation(fixturePlan('ts720'), source, video, audio);
    assert.equal(opened.length, 1, 'cached initial child must be explicitly probed');
    assert.match(opened[0], /part0.ts/);
    for (const track of [video, audio]) {
      const sink = new EncodedPacketSink(track);
      let packet = await sink.getFirstPacket();
      while (packet) packet = await sink.getNextPacket(packet);
    }
    assert.equal(opened.length, 3, 'shared video/audio identities must not be probed twice');
    source.release(input);
  } finally { source.dispose(); await source.settled(); }
});

test('separate audio and video initial children are both validated', async () => {
  const plan = fixturePlan('video1080', true);
  const { source, video, audio } = await setup(plan);
  const opened: string[] = []; const open = source.open.bind(source);
  source.open = (url, text) => { if (text) opened.push(url); return open(url, text); };
  try {
    await prepareSegmentValidation(plan, source, video, audio);
    assert.deepEqual(opened, [plan.selection.videoUrl, plan.selection.audioUrl]);
  } finally { source.dispose(); await source.settled(); }
});

test('unique changed MAPs keep lazy validation and still reject actual later configuration changes', async () => {
  const plan = mixedFixturePlan('video'); const { source, video, audio } = await setup(plan);
  let probes = 0; const open = source.open.bind(source);
  source.open = (url, text) => { if (text) probes++; return open(url, text); };
  try {
    await prepareSegmentValidation(plan, source, video, audio);
    assert.equal(probes, 2);
    for (let attempt = 0; attempt < 2; attempt++) {
      const track = attempt ? (await source.open(plan.selection.videoUrl).getPrimaryVideoTrack())! : video;
      const sink = new EncodedPacketSink(track);
      await assert.rejects(async () => { let packet = await sink.getFirstPacket(); while (packet) packet = await sink.getNextPacket(packet); }, /configuration|dimensions/);
      assert.equal(probes, 3, 'a rejected identity must reuse its rejected validation promise');
    }
  } finally { source.dispose(); await source.settled(); }
});

for (const kind of ['repeated-url', 'byte-range', 'map-collision'] as const) {
  test(`${kind} ambiguity deliberately validates eagerly`, async () => {
    const plan = fixturePlan(kind === 'map-collision' ? 'mux720' : 'ts720');
    if (kind === 'repeated-url') plan.manifests[0].text = plan.manifests[0].text.replace(/part[12].ts/g, 'part0.ts');
    let fetcher = fixtureFetch;
    if (kind === 'byte-range') {
      // Different subranges of the same object cannot be selected by a URL-only gate.
      const part = readFileSync(resolve(scratch, 'ts720/part0.ts'));
      const joined = new Uint8Array(part.length * 3);
      for (let n = 0; n < 3; n++) joined.set(part, n * part.length);
      let index = 0;
      plan.manifests[0].text = plan.manifests[0].text.replace(/(#EXTINF:[^\n]*\n)https:[^\n]*part\d.ts/g,
        (_, duration) => `${duration}#EXT-X-BYTERANGE:${part.length}@${index++ * part.length}\nhttps://fixture.test/ts720/part0.ts`);
      fetcher = async (_input, options) => {
        const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(options?.headers).get('Range')!)!;
        const start = Number(range[1]), end = Math.min(Number(range[2]), joined.length - 1);
        return new Response(joined.subarray(start, end + 1), { status: 206, headers: {
          'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${joined.length}`,
        } });
      };
    }
    if (kind === 'map-collision') {
      // An initialization URL also named as media cannot safely be a media-only gate.
      plan.manifests[0].text = plan.manifests[0].text.replace('mux720/part2.m4s', 'mux720/init.mp4');
    }
    const { source, video, audio } = await setup(plan, fetcher);
    const opened: string[] = []; const open = source.open.bind(source);
    source.open = (url, text) => { if (text) opened.push(text); return open(url, text); };
    try {
      await prepareSegmentValidation(plan, source, video, audio);
      assert.equal(opened.length, 3, 'ambiguous playlist must finish the eager preflight');
    } finally { source.dispose(); await source.settled(); }
  });
}

test('the same MAP URL with different byte-range identities deliberately validates eagerly', async () => {
  const plan = fixturePlan(); const manifest = plan.manifests[0];
  const init = readFileSync(resolve(scratch, 'mux720/init.mp4'));
  const joined = new Uint8Array(init.length * 2); joined.set(init); joined.set(init, init.length);
  const map = `#EXT-X-MAP:URI="https://fixture.test/mux720/init.mp4",BYTERANGE="${init.length}@`;
  manifest.text = manifest.text.replace(/#EXT-X-MAP:[^\n]*/, map + '0"')
    .replace(/(#EXTINF:[^\n]*\nhttps:[^\n]*part1.m4s)/, map + init.length + '"\n$1');
  const { source, video, audio } = await setup(plan, async (input, options) => {
    if (!String(input).endsWith('/init.mp4')) return fixtureFetch(input, options);
    const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(options?.headers).get('Range')!)!;
    const start = Number(range[1]), end = Math.min(Number(range[2]), joined.length - 1);
    return new Response(joined.subarray(start, end + 1), { status: 206, headers: {
      'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${joined.length}`,
    } });
  });
  const opened: string[] = []; const open = source.open.bind(source);
  source.open = (url, text) => { if (text) opened.push(text); return open(url, text); };
  try {
    await prepareSegmentValidation(plan, source, video, audio);
    assert.equal(opened.length, 3, 'every configuration must be checked before ambiguous MAP consumption');
    assert.ok(opened[0].includes(`BYTERANGE="${init.length}@0"`));
    assert.ok(opened[1].includes(`BYTERANGE="${init.length}@${init.length}"`));
  } finally { source.dispose(); await source.settled(); }
});


test('abort during a gated later probe rejects without recursive waits and settles every read', { timeout: 10_000 }, async () => {
  const plan = fixturePlan('ts720'); const controller = new AbortController();
  let blocked!: () => void;
  const pulling = new Promise<void>(resolve => { blocked = resolve; });
  const { source, video, audio } = await setup(plan, async (input, options) => {
    if (!String(input).endsWith('/part1.ts')) return fixtureFetch(input, options);
    return new Response(new ReadableStream<Uint8Array>({ pull() { blocked(); return new Promise(() => {}); } },
      { highWaterMark: 0 }), { status: 206, headers: { 'Content-Length': '188', 'Content-Range': 'bytes 0-187/188' } });
  }, controller.signal);
  let probes = 0; const open = source.open.bind(source);
  source.open = (url, text) => { if (text) probes++; return open(url, text); };
  try {
    await prepareSegmentValidation(plan, source, video, audio);
    const sink = new EncodedPacketSink(video);
    const pending = (async () => { let packet = await sink.getFirstPacket(); while (packet) packet = await sink.getNextPacket(packet); })();
    const rejected = assert.rejects(pending);
    await pulling;
    assert.equal(probes, 2, 'later media must be inside exactly one probe');
    controller.abort(); await rejected;
  } finally { controller.abort(); source.dispose(); await source.settled(); }
  assert.equal(source.metrics.active, 0); assert.equal(source.metrics.inFlightBytes, 0); assert.equal(source.metrics.cachedBytes, 0);
});
