import assert from 'node:assert/strict';
import test from 'node:test';
import type { Snapshot, TabState } from '../src/core/model.ts';

type Listener = (...args: any[]) => unknown;
function event() {
  const listeners: Listener[] = [];
  return { addListener: (listener: Listener) => { listeners.push(listener); }, fire: (...args: any[]) => listeners.map(listener => listener(...args)) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
let instance = 0;

async function background() {
  let saved: Snapshot | undefined;
  const frames = new Map<string, { documentId: string }>();
  let getFrame = async ({ tabId, frameId }: { tabId: number; frameId: number }) => frames.get(`${tabId}:${frameId}`);
  let save = async (snapshot: Snapshot) => { saved = structuredClone(snapshot); };
  const navigation = {
    onBeforeNavigate: event(), onCommitted: event(), onHistoryStateUpdated: event(), onErrorOccurred: event(),
    getFrame: (details: { tabId: number; frameId: number }) => getFrame(details),
  };
  const network = { onBeforeRequest: event(), onResponseStarted: event(), onErrorOccurred: event(), onCompleted: event() };
  const onMessage = event();
  const onRemoved = event();
  const chromeMock = {
    storage: { session: { get: async () => ({ detectionState: saved }), set: async (value: { detectionState: Snapshot }) => save(value.detectionState) } },
    webNavigation: navigation,
    webRequest: network,
    tabs: { onRemoved, query: async () => [{ id: 1 }], sendMessage: async () => undefined },
    runtime: { onMessage, getURL: (path: string) => `chrome-extension://fixture/${path}` },
  };
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: chromeMock });
  await import(`../src/background/index.ts?integration=${instance++}`);
  await settle();
  function message(raw: unknown, sender: object) {
    return new Promise<any>(resolve => { onMessage.fire(raw, sender, resolve); });
  }
  async function snapshot(tabId = 1): Promise<TabState | undefined> {
    await settle();
    return (await message({ type: 'snapshot', tabId }, { url: 'chrome-extension://fixture/popup.html' })).tab;
  }
  function commit(documentId = 'top-old', frameId = 0, tabId = 1) {
    frames.set(`${tabId}:${frameId}`, { documentId });
    navigation.onCommitted.fire({ tabId, frameId, documentId, url: 'https://page.test/old/', timeStamp: 1 });
  }
  function observe(url: string, documentId = 'top-old', frameId = 0, tabId = 1) {
    return message({ type: 'observe', observations: [{ url, method: 'dom', title: 'Player title' }] },
      { tab: { id: tabId, url: 'https://page.test/old/' }, frameId, documentId, documentLifecycle: 'active', url: 'https://page.test/old/' });
  }
  function request(requestId: string, documentId = 'top-old', frameId = 0, tabId = 1) {
    network.onBeforeRequest.fire({ requestId, tabId, frameId, documentId, url: 'https://cdn.test/movie.mp4' });
  }
  function respond(requestId: string, documentId = 'top-old', frameId = 0, tabId = 1) {
    network.onResponseStarted.fire({ requestId, tabId, frameId, documentId, url: 'https://cdn.test/movie.mp4', statusCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }] });
  }
  return { navigation, network, frames, onRemoved, commit, observe, request, respond, snapshot,
    setGetFrame: (next: typeof getFrame) => { getFrame = next; },
    setSave: (next: typeof save) => { save = next; } };
}

test('top navigation rejects old descendant requests started before its commit', async () => {
  const bg = await background();
  bg.commit(); bg.commit('child-old', 7);
  await bg.snapshot();
  bg.navigation.onBeforeNavigate.fire({ tabId: 1, frameId: 0, url: 'https://page.test/new/', timeStamp: 2 });
  bg.request('old-child', 'child-old', 7);
  await bg.snapshot();
  bg.commit('top-new');
  bg.respond('old-child', 'child-old', 7);
  const tab = await bg.snapshot();
  assert.deepEqual(Object.keys(tab!.media), []);
  assert.equal(tab!.documents[7], undefined);
});

test('top navigation rejects old descendant content while commit is pending', async () => {
  const bg = await background();
  bg.commit(); bg.commit('child-old', 7);
  await bg.snapshot();
  bg.navigation.onBeforeNavigate.fire({ tabId: 1, frameId: 0, url: 'https://page.test/new/', timeStamp: 2 });
  await bg.observe('https://cdn.test/stale.mp4', 'child-old', 7);
  assert.deepEqual(Object.keys((await bg.snapshot())!.media), []);
});

test('same-document history changes preserve network evidence and generation', async () => {
  const bg = await background();
  bg.commit();
  await bg.observe('https://cdn.test/movie.mp4');
  bg.request('movie'); bg.respond('movie');
  const before = (await bg.snapshot())!;
  assert.equal(before.media['https://cdn.test/movie.mp4'].status, 'confirmed');
  bg.navigation.onHistoryStateUpdated.fire({ tabId: 1, frameId: 0, documentId: 'top-old', url: 'https://page.test/next/', timeStamp: 3 });
  const after = (await bg.snapshot())!;
  assert.equal(after.epoch, before.epoch);
  assert.deepEqual(after.media, before.media);
  assert.equal(after.url, 'https://page.test/next/');
  assert.equal(after.title, 'Player title');
});

test('same-document history changes preserve confirmed manifest variants', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720\n720.m3u8\n'));
  const bg = await background();
  bg.commit();
  await bg.observe('https://cdn.test/master.m3u8');
  const before = (await bg.snapshot())!;
  assert.equal(before.media['https://cdn.test/master.m3u8'].status, 'confirmed');
  assert.equal(before.media['https://cdn.test/master.m3u8'].variants[0].height, 720);
  bg.navigation.onHistoryStateUpdated.fire({ tabId: 1, frameId: 0, documentId: 'top-old', url: 'https://page.test/next/', timeStamp: 3 });
  const after = (await bg.snapshot())!;
  assert.equal(after.epoch, before.epoch);
  assert.deepEqual(after.media, before.media);
});

test('content validation completing after tab removal cannot recreate the closed tab', async () => {
  const bg = await background();
  bg.commit(); await bg.snapshot();
  const frame = deferred<{ documentId: string }>();
  bg.setGetFrame(() => frame.promise);
  const observing = bg.observe('https://cdn.test/stale.mp4');
  bg.onRemoved.fire(1);
  frame.resolve({ documentId: 'top-old' });
  await observing;
  assert.equal(await bg.snapshot(), undefined);
});

for (const frameId of [0, 7]) {
  test(`content awaiting frame validation is rejected when frame ${frameId} starts navigating`, async () => {
    const bg = await background();
    bg.commit();
    if (frameId) bg.commit('child-old', frameId);
    await bg.snapshot();
    const documentId = frameId ? 'child-old' : 'top-old';
    const frame = deferred<{ documentId: string }>();
    bg.setGetFrame(() => frame.promise);
    const observing = bg.observe('https://cdn.test/stale.mp4', documentId, frameId);
    bg.navigation.onBeforeNavigate.fire({ tabId: 1, frameId, url: 'https://page.test/new/', timeStamp: 2 });
    frame.resolve({ documentId });
    await observing;
    assert.deepEqual(Object.keys((await bg.snapshot())!.media), []);
  });
}

test('unrelated frame navigation leaves the active top document usable', async () => {
  const bg = await background();
  bg.commit(); bg.commit('child-old', 7);
  await bg.snapshot();
  bg.navigation.onBeforeNavigate.fire({ tabId: 1, frameId: 7, url: 'https://frame.test/new/', timeStamp: 2 });
  await bg.observe('https://cdn.test/current.mp4');
  assert.ok((await bg.snapshot())!.media['https://cdn.test/current.mp4']);
});

test('stale history notifications cannot clear a newer committed document', async () => {
  const bg = await background();
  bg.commit('top-new');
  await bg.observe('https://cdn.test/current.mp4', 'top-new');
  const before = await bg.snapshot();
  bg.navigation.onHistoryStateUpdated.fire({ tabId: 1, frameId: 0, documentId: 'top-old', url: 'https://page.test/stale/', timeStamp: 2 });
  assert.deepEqual(await bg.snapshot(), before);
});

test('existing tabs without prior navigation events can report validated content', async () => {
  const bg = await background();
  bg.frames.set('1:0', { documentId: 'existing' });
  await bg.observe('https://cdn.test/current.mp4', 'existing');
  assert.ok((await bg.snapshot())!.media['https://cdn.test/current.mp4']);
});

test('a reused tab ID cannot revive old content validation after lifecycle eviction', async () => {
  const bg = await background();
  bg.commit(); await bg.snapshot();
  const frame = deferred<{ documentId: string }>();
  bg.setGetFrame(() => frame.promise);
  const observing = bg.observe('https://cdn.test/stale.mp4');
  bg.onRemoved.fire(1);
  for (let tabId = 2; tabId < 1100; tabId++) bg.onRemoved.fire(tabId);
  bg.commit('top-old');
  frame.resolve({ documentId: 'top-old' });
  await observing;
  assert.deepEqual(Object.keys((await bg.snapshot())!.media), []);
});

test('a late network response cannot acquire a reused tab ID and generation', async () => {
  const bg = await background();
  bg.commit(); await bg.snapshot();
  bg.request('old-response');
  await bg.snapshot();
  bg.onRemoved.fire(1);
  bg.commit('top-old');
  await bg.snapshot();
  bg.respond('old-response');
  assert.deepEqual(Object.keys((await bg.snapshot())!.media), []);
});

test('content validated before navigation cannot write stale evidence from the store queue', async () => {
  const bg = await background();
  bg.commit(); await bg.snapshot();
  const saving = deferred<void>();
  const written: Snapshot[] = [];
  bg.setSave(async snapshot => { written.push(structuredClone(snapshot)); await saving.promise; });
  bg.commit('child-old', 7);
  await settle();
  const observing = bg.observe('https://cdn.test/stale.mp4');
  await settle(); // getFrame completed; the observation is waiting behind the blocked save.
  bg.navigation.onBeforeNavigate.fire({ tabId: 1, frameId: 0, url: 'https://page.test/new/', timeStamp: 2 });
  saving.resolve();
  await observing; await bg.snapshot();
  assert.equal(written.some(snapshot => !!snapshot.tabs[1]?.media['https://cdn.test/stale.mp4']), false);
});
