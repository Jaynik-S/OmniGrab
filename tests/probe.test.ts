import test from 'node:test';
import assert from 'node:assert/strict';
import { DetectionStore } from '../src/background/store.ts';
import { ManifestProbe } from '../src/background/manifest-probe.ts';
import { emptySnapshot, ingest, navigate, probeStarted } from '../src/core/reducer.ts';
import type { ProbeJob, Snapshot } from '../src/core/model.ts';

const HLS = '#EXTM3U\n#EXTINF:3,\npart.ts\n#EXT-X-ENDLIST\n';
const DASH = '<MPD type="static"><Period><AdaptationSet contentType="video"><Representation id="v" bandwidth="100"><BaseURL>movie.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function candidates(count = 1, kind: 'hls' | 'dash' = 'hls') {
  let state = navigate(emptySnapshot(), 1, 'https://page.test/', 1, 'doc-a');
  const jobs: ProbeJob[] = [];
  for (let id = 0; id < count; id++) {
    const result = ingest(state, { tabId: 1, frameId: 0, epoch: 1, documentId: 'doc-a', method: 'network', url: `https://cdn.test/${id}.${kind === 'hls' ? 'm3u8' : 'mpd'}?signed=a%2Fb`, observedAt: 2 });
    state = result.state;
    assert.ok(result.probe);
    jobs.push(result.probe);
  }
  return { state, jobs };
}
function memoryStore(initial: Snapshot) {
  return new DetectionStore({ load: async () => initial, save: async () => {} });
}

test('probe persists probing before fetching, deduplicates callers, and resolves against redirect URL', async () => {
  const { state, jobs: [job] } = candidates();
  const saved = deferred<void>();
  const body = deferred<Response>();
  let saves = 0;
  let calls = 0;
  const store = new DetectionStore({ load: async () => state, save: async () => { if (++saves === 1) await saved.promise; } });
  const probe = new ManifestProbe(store, async (url, init) => {
    calls++;
    assert.equal(url, 'https://cdn.test/0.m3u8?signed=a%2Fb');
    assert.equal(init?.credentials, 'include');
    assert.equal(init?.headers, undefined);
    assert.equal((await store.read()).tabs[1].media[job.itemId].status, 'probing');
    return body.promise;
  });
  const first = probe.enqueue(job);
  const duplicate = probe.enqueue(job);
  await tick();
  assert.equal(calls, 0);
  saved.resolve();
  await tick();
  assert.equal(calls, 1);
  const response = new Response(HLS);
  Object.defineProperty(response, 'url', { value: 'https://redirect.test/final/master.m3u8?new=1' });
  body.resolve(response);
  await Promise.all([first, duplicate]);
  const item = (await store.read()).tabs[1].media[job.itemId];
  assert.equal(item.status, 'confirmed');
  assert.deepEqual(item.segmentUrls, ['https://redirect.test/final/part.ts']);
  await probe.enqueue(job);
  assert.equal(calls, 1);
});

test('recovery derives persisted observed/probing jobs and bounds active fetches at four', async () => {
  const { state, jobs } = candidates(6);
  const persisted = probeStarted(state, jobs[0]);
  const store = memoryStore(persisted);
  const pending: Array<ReturnType<typeof deferred<Response>>> = [];
  let active = 0;
  let peak = 0;
  const probe = new ManifestProbe(store, async () => {
    active++; peak = Math.max(peak, active);
    const response = deferred<Response>(); pending.push(response);
    try { return await response.promise; } finally { active--; }
  });
  const recovering = probe.recover();
  await tick();
  assert.equal(pending.length, 4);
  assert.equal(peak, 4);
  pending[0].resolve(new Response(HLS));
  pending[1].resolve(new Response(HLS));
  await tick();
  assert.equal(pending.length, 6);
  pending.slice(2).forEach(p => p.resolve(new Response(HLS)));
  await recovering;
  assert.equal(peak, 4);
  assert.deepEqual(Object.values((await store.read()).tabs[1].media).map(m => m.status), Array(6).fill('confirmed'));
});

test('stale queued jobs skip fetch and in-flight completion cannot cross navigation epochs', async () => {
  const { state, jobs } = candidates(2);
  const store = memoryStore(state);
  const response = deferred<Response>();
  let calls = 0;
  const probe = new ManifestProbe(store, async () => { calls++; return response.promise; }, { concurrency: 1 });
  const first = probe.enqueue(jobs[0]);
  const queued = probe.enqueue(jobs[1]);
  await tick();
  assert.equal(calls, 1);
  await store.dispatch(s => navigate(s, 1, 'https://page.test/new', 3, 'doc-b'));
  response.resolve(new Response(HLS));
  await Promise.all([first, queued]);
  await probe.enqueue(jobs[1]);
  assert.equal(calls, 1);
  assert.deepEqual((await store.read()).tabs[1].media, {});
});

test('deadline aborts even a fetcher that ignores its signal and records an unresolved result', async () => {
  const { state, jobs: [job] } = candidates();
  const store = memoryStore(state);
  let signal: AbortSignal | undefined;
  const probe = new ManifestProbe(store, async (_url, init) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  }, { timeoutMs: 10 });
  await probe.enqueue(job);
  const item = (await store.read()).tabs[1].media[job.itemId];
  assert.equal(signal?.aborted, true);
  assert.equal(item.status, 'unresolved');
  assert.match(item.reason ?? '', /timeout/i);
});

test('streamed body bytes are bounded without trusting absent or small Content-Length', async () => {
  for (const header of [undefined, '1']) {
    const { state, jobs: [job] } = candidates();
    const store = memoryStore(state);
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(12)); controller.enqueue(new Uint8Array(12)); },
      cancel() { canceled = true; },
    });
    const probe = new ManifestProbe(store, async () => new Response(stream, { headers: header ? { 'content-length': header } : {} }), { maxBytes: 20 });
    await probe.enqueue(job);
    const item = (await store.read()).tabs[1].media[job.itemId];
    assert.equal(item.status, 'unresolved');
    assert.match(item.reason ?? '', /size|byte/i);
    assert.equal(canceled, true);
  }
});

test('HTTP and parser failures become unresolved while protection evidence becomes unsupported', async () => {
  for (const [response, status, reason] of [
    [new Response('Forbidden', { status: 403 }), 'unresolved', /403/],
    [new Response('<html>not a manifest</html>'), 'unresolved', /HLS|manifest/i],
    [new Response('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST'), 'unsupported', /protected/],
  ] as const) {
    const { state, jobs: [job] } = candidates();
    const store = memoryStore(state);
    await new ManifestProbe(store, async () => response).enqueue(job);
    const item = (await store.read()).tabs[1].media[job.itemId];
    assert.equal(item.status, status);
    assert.match(item.reason ?? '', reason);
  }
});

test('DASH candidates use the DASH parser', async () => {
  const { state, jobs: [job] } = candidates(1, 'dash');
  const store = memoryStore(state);
  await new ManifestProbe(store, async () => new Response(DASH)).enqueue(job);
  const item = (await store.read()).tabs[1].media[job.itemId];
  assert.equal(item.status, 'confirmed');
  assert.equal(item.variants[0].representationId, 'v');
  assert.equal(item.variants[0].url, 'https://cdn.test/movie.mp4');
});

test('failure to durably mark probing prevents network traffic and does not spin retries', async () => {
  const { state, jobs: [job] } = candidates();
  let saves = 0;
  let calls = 0;
  const store = new DetectionStore({ load: async () => state, save: async () => { saves++; throw new Error('session unavailable'); } });
  const probe = new ManifestProbe(store, async () => { calls++; return new Response(HLS); });
  await assert.rejects(probe.enqueue(job), /session unavailable/);
  await tick();
  assert.equal(calls, 0);
  assert.equal(saves, 1);
  assert.equal((await store.read()).revision, state.revision);
});

test('a failed result save is surfaced without overwriting it as a fetch failure', async () => {
  const { state, jobs: [job] } = candidates();
  let saves = 0;
  const store = new DetectionStore({ load: async () => state, save: async () => {
    if (++saves === 2) throw new Error('result quota failure');
  } });
  const probe = new ManifestProbe(store, async () => new Response(HLS));
  await assert.rejects(probe.enqueue(job), /result quota failure/);
  await tick();
  assert.equal(saves, 2);
  assert.equal((await store.read()).revision, state.revision + 1);
  assert.equal((await store.read()).tabs[1].media[job.itemId].status, 'probing');
  assert.match(store.error ?? '', /quota/);
});

test('an invalid originating job cannot trigger unrelated pending manifest fetches', async () => {
  const { state, jobs: [job] } = candidates();
  let calls = 0;
  const store = memoryStore(state);
  const probe = new ManifestProbe(store, async () => { calls++; return new Response(HLS); });
  await probe.enqueue({ ...job, epoch: 0 });
  await tick();
  assert.equal(calls, 0);
  assert.equal((await store.read()).tabs[1].media[job.itemId].status, 'observed');
});

test('deadline cancels a stalled streamed body after response headers arrive', async () => {
  const { state, jobs: [job] } = candidates();
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('#EXTM3U\n')); },
    cancel() { canceled = true; },
  });
  const store = memoryStore(state);
  await new ManifestProbe(store, async () => new Response(stream), { timeoutMs: 10 }).enqueue(job);
  assert.equal(canceled, true);
  assert.equal((await store.read()).tabs[1].media[job.itemId].status, 'unresolved');
  assert.match((await store.read()).tabs[1].media[job.itemId].reason ?? '', /timeout/);
});

test('a fetch response arriving after the deadline has its body canceled without changing the result', async () => {
  const { state, jobs: [job] } = candidates();
  const response = deferred<Response>();
  const store = memoryStore(state);
  let canceled = false;
  const probe = new ManifestProbe(store, async () => response.promise, { timeoutMs: 10 });
  await probe.enqueue(job);
  const revision = (await store.read()).revision;
  response.resolve(new Response(new ReadableStream<Uint8Array>({ cancel() { canceled = true; } })));
  await tick();
  assert.equal(canceled, true);
  assert.equal((await store.read()).revision, revision);
  assert.match((await store.read()).tabs[1].media[job.itemId].reason ?? '', /timeout/);
});

test('same-URL replacement instances cannot coalesce with or receive an older frame probe', async () => {
  const { state, jobs: [job] } = candidates();
  state.tabs[1].media[job.itemId].instance = job.instance = 10;
  const store = memoryStore(state);
  const oldResponse = deferred<Response>();
  const newResponse = deferred<Response>();
  let calls = 0;
  const probe = new ManifestProbe(store, async () => ++calls === 1 ? oldResponse.promise : newResponse.promise);
  const oldWork = probe.enqueue(job);
  await tick();
  assert.equal(calls, 1);
  await store.dispatch(snapshot => {
    const next = structuredClone(snapshot);
    next.revision++;
    next.tabs[1].media[job.itemId] = { ...next.tabs[1].media[job.itemId], instance: 20, status: 'observed' };
    return next;
  });
  const newWork = probe.enqueue({ ...job, instance: 20 });
  await tick();
  assert.equal(calls, 2);
  oldResponse.resolve(new Response(HLS));
  await oldWork;
  const replacing = (await store.read()).tabs[1].media[job.itemId];
  assert.equal(replacing.instance, 20);
  assert.equal(replacing.status, 'probing');
  assert.deepEqual(replacing.segmentUrls, []);
  newResponse.resolve(new Response(HLS.replace('part.ts', 'new.ts')));
  await newWork;
  assert.deepEqual((await store.read()).tabs[1].media[job.itemId].segmentUrls, ['https://cdn.test/new.ts']);
});
