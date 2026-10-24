import assert from 'node:assert/strict';
import test from 'node:test';
import { RemuxSourceAdapter } from '../src/downloads/remux-source.ts';
import type { DownloadPlan, ResourceFetch, ResourceGrant } from '../src/downloads/model.ts';

const MiB = 1024 * 1024;
const base = 'https://media.test/';
function plan(resources: ResourceGrant[], selected = resources.map(g => g.url)): DownloadPlan {
  return { selection: { tabId: 1, epoch: 1, mediaId: 'm', instance: 1, pageUrl: base, frameId: 0,
    documentId: 'd', sourceUrl: base + 'video.m3u8', videoUrl: base + 'video.m3u8', filename: 'v.mp4', output: 'mp4' },
    resources, manifests: [{ url: base + 'video.m3u8', text: '#EXTM3U\n#EXT-X-TARGETDURATION:1\n' +
      selected.map(url => `#EXTINF:1,\n${url}\n`).join('') + '#EXT-X-ENDLIST' }] };
}
const read = async (source: RemuxSourceAdapter, url: string, start = 0, end = start, signal?: AbortSignal) => {
  const response = await source.fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal });
  return { response, bytes: new Uint8Array(await response.arrayBuffer()) };
};
async function until(check: () => boolean) {
  for (let n = 0; n < 200; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.fail('Timed out waiting for owned stream work');
}

/** Native-like headers arrive first; streams produce only on demand, one <=256 KiB chunk at a time. */
function streams(lengths: Record<string, number>, options: { delayed?: boolean; whole?: boolean } = {}) {
  const calls: Array<{ url: string; range: string; pulls: number; canceled: boolean; end: () => void }> = [];
  let active = 0, maximumActive = 0;
  const fetcher: ResourceFetch = async (input, init) => {
    init?.signal?.throwIfAborted();
    const url = String(input); const total = lengths[url]; assert.ok(total, `Unexpected URL ${url}`);
    const range = new Headers(init?.headers).get('Range')!;
    const match = /^bytes=(\d+)-(\d+)$/.exec(range)!;
    const first = options.whole ? 0 : Number(match[1]);
    const last = options.whole ? total - 1 : Math.min(Number(match[2]), total - 1);
    let position = first, finished = false, resume: (() => void) | undefined;
    const call = { url, range, pulls: 0, canceled: false, end: () => { resume?.(); } }; calls.push(call);
    active++; maximumActive = Math.max(maximumActive, active);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const finish = () => { if (!finished) { finished = true; active--; init?.signal?.removeEventListener('abort', abort); } };
    const abort = () => { call.canceled = true; finish(); controller.error(init?.signal?.reason); resume?.(); };
    const body = new ReadableStream<Uint8Array>({
      start(value) { controller = value; init?.signal?.addEventListener('abort', abort, { once: true }); },
      async pull(stream) {
        call.pulls++;
        if (options.delayed) await new Promise<void>(resolve => { resume = resolve; });
        if (finished) return;
        if (position > last) { finish(); stream.close(); return; }
        const data = Uint8Array.from({ length: Math.min(256 * 1024, last - position + 1) }, (_, n) => (position + n) % 251);
        position += data.length; stream.enqueue(data);
      },
      cancel() { call.canceled = true; finish(); resume?.(); },
    }, { highWaterMark: 0 });
    return new Response(body, { status: options.whole ? 200 : 206, headers: {
      'Content-Length': String(last - first + 1), ...(!options.whole ? { 'Content-Range': `bytes ${first}-${last}/${total}` } : {}),
    } });
  };
  return { fetcher, calls, get active() { return active; }, get maximumActive() { return maximumActive; } };
}

test('aligned 4 MiB windows reuse exact bytes, clip known EOF, and expose truthful subranges', async () => {
  const url = base + 'large.bin?sig=a%2Fb'; const fixture = streams({ [url]: 10 * MiB });
  const source = new RemuxSourceAdapter(plan([{ url }]), fixture.fetcher, new AbortController().signal, () => {}, { prefetch: false });
  try {
    assert.deepEqual([...(await read(source, url, 0, 31)).bytes], Array.from({ length: 32 }, (_, n) => n));
    const second = await read(source, url, 262144, 262175);
    assert.equal(second.response.headers.get('Content-Range'), 'bytes 262144-262175/10485760');
    assert.deepEqual([...second.bytes], Array.from({ length: 32 }, (_, n) => (262144 + n) % 251));
    assert.equal(fixture.calls.length, 1);
    await read(source, url, 4 * MiB); await read(source, url, 8 * MiB);
    assert.deepEqual(fixture.calls.map(c => c.range), ['bytes=0-4194303', 'bytes=4194304-8388607', 'bytes=8388608-10485759']);
    assert.equal(source.metrics.cachedBytes, 10 * MiB); assert.equal(source.metrics.maximumInFlightBytes, 4 * MiB);
    assert.equal(source.metrics.cacheHits, 1); assert.equal(source.metrics.inFlightBytes, 0);
  } finally { source.dispose(); }
  await source.settled(); assert.equal(source.metrics.cachedBytes, 0);
});

test('overlapping same-window demand shares its delayed physical read and owns one buffer', async () => {
  const url = base + 'shared.bin'; const fixture = streams({ [url]: MiB }, { delayed: true });
  const source = new RemuxSourceAdapter(plan([{ url }]), fixture.fetcher, new AbortController().signal, () => {}, { prefetch: false });
  const first = read(source, url, 1); const second = read(source, url, 300000);
  try {
    await until(() => fixture.calls.length > 0); assert.equal(fixture.calls.length, 1);
    for (let n = 1; n <= 5; n++) { await until(() => fixture.calls[0].pulls >= n); fixture.calls[0].end(); }
    assert.deepEqual([...(await first).bytes], [1]); assert.deepEqual([...(await second).bytes], [300000 % 251]);
    assert.equal(source.metrics.requests, 1); assert.equal(source.metrics.cachedBytes, MiB);
  } finally { source.dispose(); await Promise.allSettled([first, second]); }
  await source.settled();
});

test('canceling one overlapping consumer preserves the other consumer and custom benchmark windows', async () => {
  const url = base + 'consumers.bin'; const fixture = streams({ [url]: 512 * 1024 }, { delayed: true });
  const source = new RemuxSourceAdapter(plan([{ url }]), fixture.fetcher, new AbortController().signal, () => {}, { prefetch: false, readWindowBytes: 256 * 1024 });
  const controller = new AbortController(); const first = read(source, url, 0, 0, controller.signal), second = read(source, url, 200000);
  const rejected = assert.rejects(first, { name: 'AbortError' }); second.catch(() => {});
  try {
    await until(() => fixture.calls.length === 1 && fixture.calls[0].pulls > 0); controller.abort(); await rejected;
    assert.equal(fixture.calls[0].canceled, false); assert.equal(fixture.calls[0].range, 'bytes=0-262143');
    fixture.calls[0].end(); await until(() => fixture.calls[0].pulls === 2); fixture.calls[0].end();
    assert.deepEqual([...(await second).bytes], [200000 % 251]); assert.equal(source.metrics.requests, 1);
    assert.equal(source.metrics.maximumInFlightBytes, 256 * 1024);
  } finally { source.dispose(); await Promise.allSettled([first, second]); }
  await source.settled();
});

test('grant clipping and signed query identity never reuse or widen unrelated bytes', async () => {
  const a = base + 'map.bin?sig=a%2Fb', b = base + 'map.bin?sig=b%2Fa';
  const fixture = streams({ [a]: 100, [b]: 100 });
  const source = new RemuxSourceAdapter(plan([{ url: a, range: { start: 17, end: 27 } }, { url: b, range: { start: 30, end: 40 } }]),
    fixture.fetcher, new AbortController().signal, () => {}, { prefetch: false });
  try {
    assert.deepEqual([...(await read(source, a, 20, 24)).bytes], [20, 21, 22, 23, 24]);
    assert.deepEqual([...(await read(source, b, 33, 34)).bytes], [33, 34]);
    assert.deepEqual(fixture.calls.map(c => c.range), ['bytes=17-27', 'bytes=30-40']);
    await assert.rejects(read(source, a, 16), /outside/); await assert.rejects(read(source, a.replace('a%2Fb', 'other')), /outside/);
  } finally { source.dispose(); }
});

test('window LRU evicts before 32 MiB and accounts actual independently retained ArrayBuffers', async () => {
  const url = base + 'eviction.bin'; const fixture = streams({ [url]: 40 * MiB });
  const source = new RemuxSourceAdapter(plan([{ url }]), fixture.fetcher, new AbortController().signal, () => {}, { prefetch: false });
  try {
    for (let n = 0; n < 8; n++) await read(source, url, n * 4 * MiB);
    await read(source, url, 0); await read(source, url, 32 * MiB); await read(source, url, 4 * MiB); await read(source, url, 0);
    assert.equal(fixture.calls.length, 10); assert.equal(source.metrics.cachedBytes, 32 * MiB);
    assert.equal(source.metrics.maximumCachedBytes, 32 * MiB);
    // The owned cache must not conceal a large allocation behind small subarray views.
    const blocks = [...(source as unknown as { reads: { cache: Set<{ data: Uint8Array }> } }).reads.cache];
    assert.ok(blocks.every(block => block.data.byteLength === block.data.buffer.byteLength));
    assert.equal(blocks.reduce((sum, block) => sum + block.data.buffer.byteLength, 0), source.metrics.cachedBytes);
  } finally { source.dispose(); }
});

test('selected playlist read-ahead reserves demand capacity, promotes overlaps, aborts and settles all work', async () => {
  const urls = Array.from({ length: 7 }, (_, n) => base + `part${n}.ts`); const extra = base + 'unselected.ts';
  const fixture = streams(Object.fromEntries([...urls, extra].map(url => [url, 512 * 1024])), { delayed: true });
  const source = new RemuxSourceAdapter(plan([{ url: extra }, ...urls.map(url => ({ url }))], urls), fixture.fetcher, new AbortController().signal, () => {});
  const first = read(source, urls[0]); first.catch(() => {});
  let promoted: Promise<unknown> | undefined, demand: Promise<unknown> | undefined;
  try {
    await until(() => fixture.calls.length >= 4);
    assert.deepEqual(fixture.calls.map(c => c.url), urls.slice(0, 4));
    assert.equal(source.metrics.active, 4); assert.equal(source.metrics.speculative, 3);
    // Complete foreground while the other three bodies are stalled.
    for (let n = 1; n <= 3; n++) { await until(() => fixture.calls[0].pulls >= n); fixture.calls[0].end(); }
    assert.deepEqual([...(await first).bytes], [0]);
    promoted = read(source, urls[1]); demand = read(source, urls[5]);
    promoted.catch(() => {}); demand.catch(() => {});
    await until(() => fixture.calls.some(c => c.url === urls[5]));
    assert.equal(fixture.calls.filter(c => c.url === urls[1]).length, 1);
    assert.ok(source.metrics.speculative <= 3); assert.ok(fixture.maximumActive <= 4);
    assert.ok(source.metrics.maximumInFlightBytes <= 4 * 512 * 1024);
  } finally { source.dispose(); await Promise.allSettled([first, promoted, demand]); }
  await source.settled(); assert.equal(fixture.active, 0);
  assert.equal(source.metrics.active, 0); assert.equal(source.metrics.inFlightBytes, 0); assert.equal(source.metrics.cachedBytes, 0);
});

test('unknown range-ignoring responses serialize 64 MiB allocation and abort waiting bodies promptly', async () => {
  const urls = Array.from({ length: 4 }, (_, n) => base + `whole${n}.bin`);
  const fixture = streams(Object.fromEntries(urls.map(url => [url, 64 * MiB])), { delayed: true, whole: true });
  const source = new RemuxSourceAdapter(plan(urls.map(url => ({ url }))), fixture.fetcher, new AbortController().signal, () => {}, { prefetch: false });
  const pending = urls.map(url => read(source, url)); const rejected = pending.map(p => assert.rejects(p, { name: 'AbortError' }));
  try {
    await until(() => fixture.calls.length === 4 && fixture.calls.some(c => c.pulls > 0));
    assert.equal(fixture.calls.filter(c => c.pulls > 0).length, 1);
    assert.equal(source.metrics.inFlightBytes, 64 * MiB); assert.equal(source.metrics.maximumInFlightBytes, 64 * MiB);
  } finally { source.dispose(); await Promise.all(rejected); }
  await source.settled(); assert.equal(fixture.active, 0); assert.equal(source.metrics.inFlightBytes, 0);
});

test('canceling the first whole-object allocation waiter hands capacity to the surviving read', async () => {
  const urls = ['owner.bin', 'canceled-waiter.bin', 'surviving-waiter.bin'].map(name => base + name);
  let owner!: ReadableStreamDefaultController<Uint8Array>, ownerPulls = 0, thirdPulls = 0, thirdFinished = false;
  const controller = new AbortController();
  const source = new RemuxSourceAdapter(plan(urls.map(url => ({ url }))), async (input, init) => {
    const index = urls.indexOf(String(input));
    if (index === 1) init!.signal!.addEventListener('abort', () => owner.close(), { once: true });
    return new Response(new ReadableStream<Uint8Array>({
      start(stream) { if (index === 0) owner = stream; },
      pull(stream) {
        if (index === 0) { if (++ownerPulls === 1) stream.enqueue(new Uint8Array(16).fill(11)); }
        else { if (index === 2) thirdPulls++; stream.enqueue(new Uint8Array(16).fill(index + 11)); stream.close(); }
      },
    }, { highWaterMark: 0 }), { headers: { 'Content-Length': '16' } });
  }, new AbortController().signal, () => {}, { prefetch: false });
  const first = read(source, urls[0]), second = read(source, urls[1], 0, 0, controller.signal);
  const rejected = assert.rejects(second, { name: 'AbortError' });
  const third = read(source, urls[2]).then(result => { thirdFinished = true; return result; });
  first.catch(() => {}); third.catch(() => {});
  try {
    await until(() => ownerPulls === 2 && source.metrics.active === 3);
    assert.equal(thirdPulls, 0); assert.equal(source.metrics.inFlightBytes, 16);
    controller.abort(); await rejected;
    assert.deepEqual([...(await first).bytes], [11]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(thirdFinished, true, 'surviving response must finish without another release or disposal');
    assert.deepEqual([...(await third).bytes], [13]); await source.settled();
    assert.equal(thirdPulls, 1); assert.equal(source.metrics.requests, 3);
    assert.equal(source.metrics.maximumInFlightBytes, 16); assert.equal(source.metrics.maximumActive, 3);
    assert.equal(source.metrics.active, 0); assert.equal(source.metrics.inFlightBytes, 0);
  } finally { source.dispose(); await Promise.allSettled([first, second, third]); await source.settled(); }
});

test('settlement retains its slot and staging until the original asynchronous stream cancellation finishes', async () => {
  const url = base + 'delayed-cancel.bin';
  let pulled = false, cancelStarted = false, cancelFinished = false, cancelCalls = 0, settled = false;
  let releaseCancel!: () => void;
  const cancelGate = new Promise<void>(resolve => { releaseCancel = resolve; });
  const source = new RemuxSourceAdapter(plan([{ url }]), async () => new Response(new ReadableStream<Uint8Array>({
    pull() { pulled = true; },
    async cancel() { cancelCalls++; cancelStarted = true; await cancelGate; cancelFinished = true; },
  }, { highWaterMark: 0 }), { status: 206, headers: { 'Content-Range': 'bytes 0-15/16', 'Content-Length': '16' } }),
  new AbortController().signal, () => {}, { prefetch: false });
  const pending = read(source, url), rejected = assert.rejects(pending, { name: 'AbortError' });
  let settling: Promise<void> | undefined;
  try {
    await until(() => pulled); source.dispose();
    settling = source.settled().then(() => { settled = true; });
    await until(() => cancelStarted); await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancelFinished, false); assert.equal(settled, false, 'settlement must await the first underlying cancel promise');
    assert.equal(source.metrics.active, 1); assert.equal(source.metrics.inFlightBytes, 16);
    assert.equal(source.metrics.cachedBytes, 0);
    releaseCancel(); await rejected; await settling;
    assert.equal(cancelCalls, 1); assert.equal(cancelFinished, true);
    assert.equal(source.metrics.active, 0); assert.equal(source.metrics.inFlightBytes, 0);
  } finally { releaseCancel(); source.dispose(); await rejected; await settling; await source.settled(); }
});

test('failed speculative bodies are observed, terminal, and settle without an unhandled rejection', async () => {
  const urls = [base + 'good.ts', base + 'bad.ts']; const fixture = streams({ [urls[0]]: 16 });
  const source = new RemuxSourceAdapter(plan(urls.map(url => ({ url }))), async (input, init) => {
    if (String(input) === urls[1]) return new Response(new ReadableStream({ pull(c) { c.error(new Error('body failed')); } }),
      { status: 206, headers: { 'Content-Range': 'bytes 0-15/16', 'Content-Length': '16' } });
    return fixture.fetcher(input, init);
  }, new AbortController().signal, () => {});
  try {
    await read(source, urls[0]).catch(() => {}); await until(() => { try { source.check(); return false; } catch { return true; } });
    assert.throws(() => source.check(), /body failed/);
  } finally { source.dispose(); }
  await source.settled(); assert.equal(source.metrics.active, 0);
});

test('dispose has an awaitable settlement contract even when idle', async () => {
  const source = new RemuxSourceAdapter(plan([{ url: base + 'idle.ts' }]), async () => { throw new Error('Unexpected request'); }, new AbortController().signal, () => {});
  source.dispose(); await source.settled();
});

test('selected companion audio prefetch follows its manifest and excludes other granted renditions', async () => {
  const video = base + 'v.ts', audio = [base + 'a0.ts', base + 'a1.ts', base + 'a2.ts'], extra = base + 'other.ts';
  const p = plan([extra, video, ...audio].map(url => ({ url })), [video]);
  p.selection.audioUrl = base + 'audio.m3u8';
  p.manifests.push({ url: p.selection.audioUrl, text: '#EXTM3U\n#EXT-X-TARGETDURATION:1\n' + audio.map(url => `#EXTINF:1,\n${url}\n`).join('') + '#EXT-X-ENDLIST' });
  const fixture = streams(Object.fromEntries([video, ...audio, extra].map(url => [url, 16])), { delayed: true });
  const source = new RemuxSourceAdapter(p, fixture.fetcher, new AbortController().signal, () => {});
  const pending = read(source, audio[0]); const rejected = assert.rejects(pending, { name: 'AbortError' });
  try { await until(() => fixture.calls.length >= 3); assert.deepEqual(fixture.calls.map(c => c.url), audio); }
  finally { source.dispose(); await rejected; }
  await source.settled();
});

test('read-ahead owns the next aligned windows of one selected object before later resources', async () => {
  const url = base + 'windowed.bin', next = base + 'later.ts';
  const fixture = streams({ [url]: 10 * MiB, [next]: 16 }, { delayed: true });
  const source = new RemuxSourceAdapter(plan([{ url }, { url: next }]), fixture.fetcher, new AbortController().signal, () => {});
  const pending = read(source, url), rejected = assert.rejects(pending, { name: 'AbortError' });
  try {
    await until(() => fixture.calls.length === 4);
    assert.deepEqual(fixture.calls.map(c => [c.url, c.range]), [[url, 'bytes=0-4194303'], [url, 'bytes=4194304-8388607'],
      [url, 'bytes=8388608-10485759'], [next, 'bytes=0-4194303']]);
    const promoted = read(source, url, 4 * MiB); const promotionRejected = assert.rejects(promoted, { name: 'AbortError' });
    assert.equal(source.metrics.requests, 4); assert.equal(source.metrics.speculative, 2);
    source.dispose(); await promotionRejected;
  } finally { source.dispose(); await rejected; }
  await source.settled(); assert.equal(fixture.active, 0);
});

test('selected MAP and byte-range speculative grants remain inclusive and are never widened', async () => {
  const url = base + 'ranges.bin'; const p = plan([{ url, range: { start: 17, end: 27 } }, { url, range: { start: 44, end: 55 } }]);
  p.manifests[0].text = `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MAP:URI="${url}",BYTERANGE="11@17"\n#EXTINF:1,\n#EXT-X-BYTERANGE:12@44\n${url}\n#EXT-X-ENDLIST`;
  const fixture = streams({ [url]: 100 });
  const source = new RemuxSourceAdapter(p, fixture.fetcher, new AbortController().signal, () => {});
  try {
    assert.deepEqual([...(await read(source, url, 20, 24)).bytes], [20, 21, 22, 23, 24]); await source.settled();
    assert.deepEqual(fixture.calls.map(c => c.range), ['bytes=17-27', 'bytes=44-55']);
    assert.deepEqual([...(await read(source, url, 46, 48)).bytes], [46, 47, 48]); assert.equal(source.metrics.requests, 2);
  } finally { source.dispose(); }
});

test('range-ignored origin disables further speculation while full bodies stay seekable', async () => {
  const urls = [base + 'whole-a.bin', base + 'whole-b.bin']; const fixture = streams(Object.fromEntries(urls.map(url => [url, 16])), { whole: true });
  const source = new RemuxSourceAdapter(plan(urls.map(url => ({ url }))), fixture.fetcher, new AbortController().signal, () => {});
  try {
    await read(source, urls[0]); assert.deepEqual([...(await read(source, urls[0], 8, 10)).bytes], [8, 9, 10]);
    await source.settled(); assert.deepEqual(fixture.calls.map(c => c.url), [urls[0]]); assert.equal(source.metrics.maximumSpeculative, 0);
  } finally { source.dispose(); }
});

test('repeated reads of one selected fragment keep read-ahead within the next three resources', async () => {
  const urls = Array.from({ length: 8 }, (_, n) => base + `horizon${n}.ts`);
  const fixture = streams(Object.fromEntries(urls.map(url => [url, 16])));
  const source = new RemuxSourceAdapter(plan(urls.map(url => ({ url }))), fixture.fetcher, new AbortController().signal, () => {});
  try {
    await read(source, urls[0]); await source.settled();
    for (let n = 0; n < 6; n++) { await read(source, urls[0]); await source.settled(); }
    assert.deepEqual(fixture.calls.map(c => c.url), urls.slice(0, 4));
  } finally { source.dispose(); }
});

test('queued speculation is not launched after an origin is observed ignoring ranges', async () => {
  const selected = ['first.ts', 'next1.ts', 'next2.ts', 'next3.ts'].map(name => base + name);
  const whole = ['demand1.bin', 'demand2.bin', 'demand3.bin'].map(name => base + name);
  const ranges = streams(Object.fromEntries(selected.map(url => [url, 16])));
  const complete = streams(Object.fromEntries(whole.map(url => [url, 16])), { whole: true });
  const source = new RemuxSourceAdapter(plan([...selected, ...whole].map(url => ({ url })), selected),
    (input, init) => (whole.includes(String(input)) ? complete : ranges).fetcher(input, init), new AbortController().signal, () => {});
  try {
    await Promise.all([selected[0], ...whole].map(url => read(source, url))); await source.settled();
    assert.deepEqual(ranges.calls.map(c => c.url), [selected[0]]);
    assert.equal(source.metrics.requests, 4);
  } finally { source.dispose(); }
});

test('three unknown speculative whole objects share one allocation gate beside a foreground range', async () => {
  const first = base + 'ranged.ts', urls = ['unknown1.bin', 'unknown2.bin', 'unknown3.bin'].map(name => base + name);
  const ranges = streams({ [first]: 4 * MiB }, { delayed: true });
  const complete = streams(Object.fromEntries(urls.map(url => [url, 64 * MiB])), { whole: true, delayed: true });
  const source = new RemuxSourceAdapter(plan([first, ...urls].map(url => ({ url }))),
    (input, init) => (String(input) === first ? ranges : complete).fetcher(input, init), new AbortController().signal, () => {});
  const pending = read(source, first), rejected = assert.rejects(pending, { name: 'AbortError' });
  try {
    await until(() => complete.calls.length === 3 && complete.calls.some(c => c.pulls));
    assert.equal(complete.calls.filter(c => c.pulls).length, 1);
    assert.equal(source.metrics.inFlightBytes, 68 * MiB); assert.equal(source.metrics.maximumSpeculative, 3);
    assert.equal(source.metrics.maximumActive, 4);
  } finally { source.dispose(); await rejected; }
  await source.settled(); assert.equal(complete.active, 0); assert.equal(ranges.active, 0); assert.equal(source.metrics.inFlightBytes, 0);
});

test('invalid ranges, lengths, encoded or truncated bodies are terminal without retained staging', async () => {
  const url = base + 'invalid.bin';
  for (const [status, headers, bytes, pattern, restricted] of [
    [200, { 'Content-Length': String(64 * MiB + 1) }, 1, /ignored range/, false],
    [200, { 'Content-Length': 'bad' }, 1, /ignored range/, false],
    [200, { 'Content-Length': '4' }, 4, /ignored range/, true],
    [206, { 'Content-Range': 'bytes 0-3/8', 'Content-Length': '4' }, 4, /range/, false],
    [206, { 'Content-Range': 'bytes 0-3/4', 'Content-Length': '3' }, 3, /length/, false],
    [206, { 'Content-Range': 'bytes 0-3/4', 'Content-Length': '4' }, 3, /Truncated/, false],
    [206, { 'Content-Range': 'bytes 0-3/4', 'Content-Length': '4' }, 5, /limit/, false],
    [206, { 'Content-Range': 'bytes 0-3/4', 'Content-Length': '4', 'Content-Encoding': 'gzip' }, 4, /Encoded/, false],
  ] as const) {
    const source = new RemuxSourceAdapter(plan([{ url, ...(restricted ? { range: { start: 0, end: 3 } } : {}) }]),
      async () => new Response(new Uint8Array(bytes), { status, headers }), new AbortController().signal, () => {}, { prefetch: false });
    try { await assert.rejects(read(source, url), pattern); assert.equal(source.metrics.cachedBytes, 0); assert.equal(source.metrics.inFlightBytes, 0); }
    finally { source.dispose(); await source.settled(); }
  }
});
