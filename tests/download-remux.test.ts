import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { writeFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixtureFetch, fixturePlan, fixtures, MemoryOutput, mixedFixturePlan, scratch } from './download-fixtures.ts';
import { remuxToMp4 } from '../src/downloads/remux.ts';
import { RemuxSourceAdapter } from '../src/downloads/remux-source.ts';

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
  });
}

test('already aborted jobs close output without fetching media', async () => {
  const controller = new AbortController(); controller.abort(); const output = new MemoryOutput();
  await assert.rejects(remuxToMp4(fixturePlan(), { fetcher: async () => { throw new Error('Must not fetch'); }, output, signal: controller.signal }), { name: 'AbortError' });
  assert.ok(output.closed);
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
  const block = 256 * 1024; const url = 'https://fixture.test/large.bin';
  const plan = fixturePlan(); plan.resources = [{ url }];
  let requests = 0;
  const source = new RemuxSourceAdapter(plan, async (_input, init) => {
    requests++;
    const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('Range')!)!;
    const start = Number(match[1]); const end = Number(match[2]);
    assert.equal(end - start + 1, block);
    return new Response(new Uint8Array(block).fill(start / block), { status: 206, headers: {
      'Content-Range': `bytes ${start}-${end}/${129 * block}`, 'Content-Length': String(block),
    } });
  }, new AbortController().signal, () => {});
  const read = async (index: number) => {
    const response = await source.fetch(url, { headers: { Range: `bytes=${index * block}-${index * block}` } });
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [index]);
  };
  try {
    for (let index = 0; index < 128; index++) await read(index);
    await read(0); assert.equal(requests, 128);
    await read(128); assert.equal(requests, 129);
    await read(1); assert.equal(requests, 130);
    await read(0); assert.equal(requests, 130);
  } finally { source.dispose(); }
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
  const block = 256 * 1024; const length = 130 * block;
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
    assert.deepEqual(ranges, ['bytes=0-262143', 'bytes=0-262143']);
    const cached = await source.fetch(url, { headers: { Range: `bytes=${block}-${block}` } });
    assert.deepEqual([...new Uint8Array(await cached.arrayBuffer())], [91]); assert.equal(requests, 2);
  } finally { source.dispose(); }
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
