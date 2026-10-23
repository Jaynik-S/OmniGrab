import assert from 'node:assert/strict';
import test from 'node:test';
import { DownloadStore } from '../src/downloads/store.ts';
import type { DownloadJob, DownloadState } from '../src/downloads/model.ts';

function job(id: string, phase: DownloadJob['phase'] = 'queued'): DownloadJob {
  return { version: 1, id, requestId: `request-${id}`, phase, createdAt: 1, updatedAt: 2,
    selection: { tabId: 7, epoch: 3, mediaId: `https://media.test/${id}/master?secret=a%2Fb`, instance: 4,
      pageUrl: 'https://page.test/watch', frameId: 0, documentId: 'doc', sourceUrl: `https://media.test/${id}/master?secret=a%2Fb`,
      videoUrl: `https://media.test/${id}/720?sig=a%2Fb`, width: 1280, height: 720, filename: 'movie.mp4', output: 'mp4', requestedVariantId: 'hls:2' },
    progress: { phase: 'processing', inputBytes: 0, outputBytes: 0 } };
}
const state = (...jobs: DownloadJob[]): DownloadState => ({ version: 1, jobs });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { resolve, promise };
}

test('serializes restoration and concurrent dispatches with save before acknowledgment', async () => {
  const restore = deferred<DownloadState | undefined>(); const save = deferred<void>();
  const writes: DownloadState[] = [];
  const store = new DownloadStore({ load: () => restore.promise, save: async next => {
    writes.push(structuredClone(next)); if (writes.length === 1) await save.promise;
  } });
  let acknowledged = false;
  const first = store.dispatch(s => ({ ...s, jobs: [...s.jobs, job('first')] })).then(s => { acknowledged = true; return s; });
  const second = store.dispatch(s => ({ ...s, jobs: [...s.jobs, job('second')] }));
  await tick(); assert.equal(writes.length, 0);
  restore.resolve(state()); await tick(); assert.equal(writes.length, 1); assert.equal(acknowledged, false);
  save.resolve(); await first; await second;
  assert.deepEqual((await store.read()).jobs.map(j => j.id), ['first', 'second']);
  assert.deepEqual(writes.map(s => s.jobs.length), [1, 2]);
});

test('clones restored state, reads, transition input, save input and dispatch results', async () => {
  const original = state(job('first')); let saved: DownloadState | undefined;
  const store = new DownloadStore({ load: async () => original, save: async s => { saved = s; } });
  const read = await store.read(); original.jobs[0].selection.height = 1; read.jobs[0].selection.height = 2;
  const next = await store.dispatch(s => { s.jobs[0].selection.height = 720; return s; });
  next.jobs[0].selection.height = 3; saved!.jobs[0].selection.height = 4;
  assert.equal((await store.read()).jobs[0].selection.height, 720);
});

test('failed writes preserve committed state, keep the queue usable and redact diagnostics', async () => {
  let calls = 0;
  const store = new DownloadStore({ load: async () => undefined, save: async () => {
    if (++calls === 1) throw new Error('failure https://media.test/?secret=private');
  } });
  await assert.rejects(store.dispatch(() => state(job('lost'))), error => {
    assert.ok(error instanceof Error); assert.ok(!error.message.includes('secret')); return true;
  });
  assert.deepEqual(await store.read(), state()); assert.ok(!store.error?.includes('secret'));
  await store.dispatch(() => state(job('saved')));
  assert.equal((await store.read()).jobs[0].id, 'saved'); assert.equal(store.error, undefined);
});

test('restore rejects future versions, malformed jobs, unbounded fields and unexpected media bytes', async () => {
  const invalid: unknown[] = [{ version: 2, jobs: [] }, { version: 1, jobs: null }, state({ ...job('a'), version: 2 } as unknown as DownloadJob),
    state({ ...job('a'), phase: 'bogus' } as unknown as DownloadJob), state({ ...job('a'), progress: { phase: 'processing', inputBytes: -1, outputBytes: 0 } }),
    state({ ...job('a'), tempFile: '../escape' }), state({ ...job('a'), id: 'x'.repeat(129) }),
    state({ ...job('a'), failure: { code: 'failure', message: 'x'.repeat(513) } }),
    { version: 1, jobs: [{ ...job('a'), bytes: new Uint8Array(10) }] },
    state({ ...job('a'), selection: { ...job('a').selection, videoUrl: 'file:///private' } }),
    state({ ...job('a'), selection: { ...job('a').selection, requestedVariantId: 7 } } as unknown as DownloadJob),
    state(job('a'), job('a'))];
  for (const raw of invalid) {
    const store = new DownloadStore({ load: async () => raw, save: async () => {} });
    assert.deepEqual(await store.read(), state()); assert.match(store.error ?? '', /invalid|restore/i);
    await store.dispatch(() => state(job('recovered')));
    assert.equal((await store.read()).jobs.length, 1);
  }
});

test('caps processing and queued jobs while deduplicating requests and active exact selections', async () => {
  const store = new DownloadStore({ load: async () => undefined, save: async () => {} });
  await store.dispatch(() => state(job('active', 'processing'), job('one'), job('two')));
  await assert.rejects(store.dispatch(s => ({ ...s, jobs: [...s.jobs, job('three')] })), /queue|limit/i);
  await assert.rejects(store.dispatch(() => state(job('a', 'resolving'), job('b', 'saving'))), /active|limit/i);
  await assert.rejects(store.dispatch(() => state(job('a'), { ...job('b'), requestId: 'request-a' })), /duplicate/i);
  await assert.rejects(store.dispatch(() => state(job('a'), { ...job('b'), selection: job('a').selection })), /duplicate/i);
  // A different quality is a distinct source selection; a terminal job permits a new request.
  await store.dispatch(() => state(job('a', 'complete'), { ...job('b'), selection: job('a').selection }));
  await store.dispatch(() => state(job('a'), { ...job('b'), selection: { ...job('a').selection, videoUrl: 'https://media.test/a/1080' } }));
  assert.equal((await store.read()).jobs.length, 2);
});

test('retains the newest 50 terminal records without pruning pending work', async () => {
  const store = new DownloadStore({ load: async () => undefined, save: async () => {} });
  for (let i = 0; i < 55; i++) await store.dispatch(s => ({ ...s, jobs: [...s.jobs, { ...job(`done-${i}`, 'complete'), updatedAt: i + 2 }] }));
  const result = await store.dispatch(s => ({ ...s, jobs: [...s.jobs, job('active', 'processing'), job('queued')] }));
  assert.equal(result.jobs.length, 52);
  assert.equal(result.jobs.filter(j => j.phase === 'complete').length, 50);
  assert.equal(result.jobs.some(j => j.id === 'done-0'), false);
  assert.equal(result.jobs.some(j => j.id === 'done-54'), true);
  const persisted = result;
  const restored = new DownloadStore({ load: async () => persisted, save: async () => {} });
  assert.deepEqual(await restored.read(), result);
});
test('validates durable attachment identity and exact unique extension blob save intent', async () => {
  const active = job('active', 'ready-to-save');
  active.attachment = { jobId: active.id, capability: 'a'.repeat(64), tabId: 7, frameId: 0, documentId: 'doc' };
  active.saveIntent = { objectUrl: 'blob:chrome-extension://' + 'a'.repeat(32) + '/unique-file', attemptedAt: 2 };
  const good = new DownloadStore({ load: async () => state(active), save: async () => {} });
  assert.equal((await good.read()).jobs.length, 1);
  for (const change of [
    (j: DownloadJob) => { j.attachment!.jobId = 'other'; },
    (j: DownloadJob) => { j.attachment!.frameId = 9; },
    (j: DownloadJob) => { j.attachment!.documentId = 'other'; },
    (j: DownloadJob) => { j.attachment!.capability = 'short'; },
    (j: DownloadJob) => { j.saveIntent!.objectUrl = 'blob:https://site.test/file'; },
    (j: DownloadJob) => { j.saveIntent!.attemptedAt = 99; },
    (j: DownloadJob) => { j.phase = 'queued'; },
  ]) {
    const invalid = structuredClone(active); change(invalid);
    const store = new DownloadStore({ load: async () => state(invalid), save: async () => {} });
    assert.equal((await store.read()).jobs.length, 0); assert.ok(store.error);
  }
  const duplicate = { ...job('other', 'complete'), saveIntent: active.saveIntent };
  const store = new DownloadStore({ load: async () => state(active, duplicate), save: async () => {} });
  assert.equal((await store.read()).jobs.length, 0); assert.ok(store.error);
});
test('retention preserves oldest uncertain resource owner when a queued cancellation adds record 51', async () => {
  const uncertain = job('uncertain', 'interrupted'); uncertain.updatedAt = 2;
  uncertain.attachment = { jobId: uncertain.id, capability: 'a'.repeat(64), tabId: 7, frameId: 0, documentId: 'doc' };
  uncertain.tempFile = 'uncertain.mp4'; uncertain.saveIntent = { objectUrl: 'blob:chrome-extension://' + 'a'.repeat(32) + '/uncertain', attemptedAt: 2 };
  uncertain.failure = { code: 'download-save-uncertain', message: 'Save outcome unknown' };
  const history = Array.from({ length: 49 }, (_, i) => ({ ...job('old' + i, 'complete'), updatedAt: 3 + i }));
  const store = new DownloadStore({ load: async () => state(uncertain, ...history, job('queued')), save: async () => {} });
  const after = await store.dispatch(s => { const q = s.jobs.find(j => j.id === 'queued')!; q.phase = 'canceled'; q.updatedAt = 100; return s; });
  assert.equal(after.jobs.length, 50); assert.deepEqual(after.jobs.find(j => j.id === 'uncertain'), uncertain);
  assert.equal(after.jobs.some(j => j.id === 'old0'), false); assert.ok(after.jobs.some(j => j.id === 'queued'));
});
test('retention refuses to discard authority when every terminal slot owns unresolved resources', async () => {
  const protectedJobs = Array.from({ length: 50 }, (_, i) => ({ ...job('resource' + i, 'failed'), tempFile: 'resource' + i + '.mp4' }));
  const store = new DownloadStore({ load: async () => state(...protectedJobs, job('queued')), save: async () => {} });
  await assert.rejects(store.dispatch(s => { const q = s.jobs.find(j => j.id === 'queued')!; q.phase = 'failed'; q.tempFile = 'queued.mp4'; return s; }), /retention|recovery/i);
  assert.equal((await store.read()).jobs.length, 51); assert.equal((await store.read()).jobs.at(-1)!.phase, 'queued');
});
