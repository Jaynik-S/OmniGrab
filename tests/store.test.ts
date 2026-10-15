import test from 'node:test';
import assert from 'node:assert/strict';
import { DetectionStore } from '../src/background/store.ts';
import { emptySnapshot, ingest, navigate } from '../src/core/reducer.ts';
import type { Snapshot } from '../src/core/model.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('restoration precedes concurrent mutations and acknowledgments wait for each save', async () => {
  const loaded = deferred<Snapshot | undefined>();
  const firstSave = deferred<void>();
  const saved: Snapshot[] = [];
  const store = new DetectionStore({ load: () => loaded.promise, save: async s => {
    saved.push(structuredClone(s));
    if (saved.length === 1) await firstSave.promise;
  } });
  let acknowledged = false;
  const first = store.dispatch(s => navigate(s, 2, 'https://page.test/two', 20)).then(s => { acknowledged = true; return s; });
  const second = store.dispatch(s => navigate(s, 3, 'https://page.test/three', 30));
  await tick();
  assert.equal(saved.length, 0);
  loaded.resolve(navigate(emptySnapshot(), 1, 'https://page.test/one', 10));
  await tick();
  assert.equal(saved.length, 1);
  assert.equal(acknowledged, false);
  assert.equal(saved[0].revision, 2);
  firstSave.resolve();
  assert.equal((await first).revision, 2);
  assert.equal((await second).revision, 3);
  assert.deepEqual(Object.keys((await store.read()).tabs), ['1', '2', '3']);
  assert.deepEqual(saved.map(s => s.revision), [2, 3]);
});

test('failed saves retain committed state and revision while later mutations continue', async () => {
  let attempts = 0;
  const store = new DetectionStore({ load: async () => undefined, save: async () => {
    if (++attempts === 1) throw new Error('session quota exceeded');
  } });
  await assert.rejects(store.dispatch(s => navigate(s, 1, 'https://page.test/lost', 10)), /quota/);
  assert.equal((await store.read()).revision, 0);
  assert.deepEqual((await store.read()).tabs, {});
  assert.match(store.error ?? '', /quota/);
  const saved = await store.dispatch(s => navigate(s, 2, 'https://page.test/saved', 20));
  assert.equal(saved.revision, 1);
  assert.deepEqual(Object.keys(saved.tabs), ['2']);
  assert.equal(store.error, undefined);
});

test('reads, restoration and dispatched results cannot mutate committed nested data', async () => {
  const original = ingest(navigate(emptySnapshot(), 1, 'https://page.test/', 1), {
    tabId: 1, frameId: 0, url: 'https://cdn.test/movie.mp4', method: 'dom', observedAt: 2,
  }).state;
  const store = new DetectionStore({ load: async () => original, save: async () => {} });
  const read = await store.read();
  original.tabs[1].media['https://cdn.test/movie.mp4'].methods.push('adapter');
  read.tabs[1].media['https://cdn.test/movie.mp4'].methods.push('resource');
  const result = await store.dispatch(s => navigate(s, 2, 'https://page.test/next', 3));
  result.tabs[1].media['https://cdn.test/movie.mp4'].methods.push('network');
  assert.deepEqual((await store.read()).tabs[1].media['https://cdn.test/movie.mp4'].methods, ['dom']);
});

test('restoration rejects malformed versions, nested shapes and unbounded collections safely', async () => {
  const valid = navigate(emptySnapshot(), 1, 'https://page.test/', 1);
  const malformed: unknown[] = [
    { version: 2, revision: 1, tabs: {} },
    { version: 1, revision: -1, tabs: {} },
    { ...valid, tabs: { 1: { ...valid.tabs[1], media: null } } },
    { ...valid, tabs: { 1: { ...valid.tabs[1], documents: { 0: 123 } } } },
    { ...valid, tabs: { 1: { ...valid.tabs[1], media: { bad: { id: 'bad', url: 'bad' } } } } },
    { ...valid, tabs: Object.fromEntries(Array.from({ length: 51 }, (_, id) => [id, { ...valid.tabs[1], id }])) },
  ];
  for (const value of malformed) {
    const store = new DetectionStore({ load: async () => value as Snapshot, save: async () => {} });
    assert.deepEqual(await store.read(), { version: 1, revision: 0, tabs: {} });
    assert.match(store.error ?? '', /snapshot/i);
    assert.equal((await store.dispatch(s => navigate(s, 2, 'https://page.test/', 2))).revision, 1);
  }
});

test('a rejected restore exposes its error and does not poison subsequent dispatches', async () => {
  const store = new DetectionStore({ load: async () => { throw new Error('session unavailable'); }, save: async () => {} });
  assert.equal((await store.read()).revision, 0);
  assert.match(store.error ?? '', /session unavailable/);
  assert.equal((await store.dispatch(s => navigate(s, 1, 'https://page.test/', 1))).revision, 1);
});
