import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchManifestForPage, isTrustedManifestSender } from '../src/content/manifest-fetch.ts';
import { readManifestBody } from '../src/manifests/response.ts';
import { createPageManifestFetcher } from '../src/background/page-manifest.ts';
import { DetectionStore } from '../src/background/store.ts';
import { bindDocument, emptySnapshot, ingest, navigate } from '../src/core/reducer.ts';

const HLS = '#EXTM3U\n#EXTINF:3,\npart.ts\n#EXT-X-ENDLIST\n';
function response(text = HLS, url = 'https://cdn.test/final/list.m3u8', status = 200): Response {
  const value = new Response(text, { status });
  Object.defineProperty(value, 'url', { value: url });
  return value;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  let state = navigate(emptySnapshot(), 1, 'https://page.test/', 1, 'doc-a');
  state = bindDocument(state, 1, 7, 'doc-frame');
  const result = ingest(state, { tabId: 1, frameId: 7, documentId: 'doc-frame', epoch: 1,
    method: 'network', url: 'https://cdn.test/master.m3u8?signature=a%2Fb', observedAt: 2 });
  assert.ok(result.probe);
  const store = new DetectionStore({ load: async () => result.state, save: async () => {} });
  return { store, job: result.probe };
}
function browser(context: test.TestContext, overrides: {
  getFrame?: (details: { tabId: number; frameId: number }) => Promise<unknown>;
  sendMessage?: (tabId: number, message: unknown, options: unknown) => Promise<unknown>;
} = {}) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const api = {
    webNavigation: { getFrame: overrides.getFrame ?? (async () => ({ documentId: 'doc-frame', frameId: 7,
      url: 'https://player.test/embed', documentLifecycle: 'active' })) },
    tabs: { sendMessage: overrides.sendMessage ?? (async () => ({ ok: true, url: 'https://cdn.test/final/list.m3u8', text: HLS, status: 200 })) },
  };
  Object.defineProperty(globalThis, 'chrome', { value: api, configurable: true });
  context.after(() => { if (original) Object.defineProperty(globalThis, 'chrome', original); else Reflect.deleteProperty(globalThis, 'chrome'); });
  return api;
}

test('page fetch uses ordinary same-origin credentials and keeps the default Window fetch receiver', async context => {
  context.mock.method(globalThis, 'fetch', async function (this: unknown, url: RequestInfo | URL, init?: RequestInit) {
    assert.equal(this, globalThis);
    assert.equal(url, 'https://cdn.test/master.m3u8?signature=a%2Fb');
    assert.equal(init?.credentials, 'same-origin');
    assert.equal(init?.headers, undefined);
    return response();
  });
  assert.deepEqual(await fetchManifestForPage('https://cdn.test/master.m3u8?signature=a%2Fb#discard'),
    { ok: true, url: 'https://cdn.test/final/list.m3u8', text: HLS, status: 200 });
});

test('page fetch rejects non-HTTP, credential-bearing, malformed and overlong URLs before touching the network', async () => {
  const fetcher = async () => { assert.fail('invalid manifest URL reached fetch'); };
  for (const url of [null, {}, 'blob:https://page.test/id', 'file:///private', 'https://user:pass@cdn.test/list', 'relative.m3u8', `https://cdn.test/${'a'.repeat(16_384)}`]) {
    const value = await fetchManifestForPage(url, { fetcher });
    assert.equal(value.ok, false);
  }
});

test('page fetch rejects HTTP errors and untrustworthy final redirect URLs', async () => {
  for (const value of [response('missing', undefined, 404), response(HLS, 'file:///private'), response(HLS, 'https://u:p@cdn.test/list')]) {
    const result = await fetchManifestForPage('https://cdn.test/list.m3u8', { fetcher: async () => value });
    assert.equal(result.ok, false);
  }
});

test('bounded reader rejects UTF-8 byte overflow, declared overflow and malformed UTF-8', async () => {
  const signal = new AbortController().signal;
  await assert.rejects(readManifestBody(new Response('ééé'), 5, signal), /manifest-size-limit/);
  await assert.rejects(readManifestBody(new Response('tiny', { headers: { 'content-length': '500' } }), 20, signal), /manifest-size-limit/);
  await assert.rejects(readManifestBody(new Response(new Uint8Array([0xc3, 0x28])), 20, signal));
  assert.equal(await readManifestBody(new Response('éé'), 4, signal), 'éé');
});

test('page fetch timeout bounds a fetch that ignores cancellation', async () => {
  const result = await fetchManifestForPage('https://cdn.test/list.m3u8', {
    timeoutMs: 20, fetcher: () => new Promise<Response>(() => {}),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /timeout/);
});

test('page fetch timeout also cancels a stalled response stream', async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { canceled = true; } });
  const value = new Response(body);
  Object.defineProperty(value, 'url', { value: 'https://cdn.test/list.m3u8' });
  const result = await fetchManifestForPage('https://cdn.test/list.m3u8', { timeoutMs: 20, fetcher: async () => value });
  assert.equal(result.ok, false);
  assert.equal(canceled, true);
});

test('page fetch enforces the body limit instead of trusting Content-Length or character count', async () => {
  const result = await fetchManifestForPage('https://cdn.test/list.m3u8', { maxBytes: 5, fetcher: async () => response('ééé') });
  assert.equal(result.ok, false);
});

test('manifest messages require the same extension and an extension-owned sender', () => {
  const id = 'abcdefghijklmnop';
  assert.equal(isTrustedManifestSender({ id, url: `chrome-extension://${id}/background.js` }, id), true);
  assert.equal(isTrustedManifestSender({ id, origin: `chrome-extension://${id}` }, id), true);
  for (const sender of [{ id: 'other', url: `chrome-extension://${id}/background.js` }, { id, url: 'https://page.test/' },
    { id, url: `chrome-extension://${id}.evil/background.js` }, { id },
    { id, url: `chrome-extension://${id}/popup.html`, tab: { id: 9 } }]) {
    assert.equal(isTrustedManifestSender(sender as chrome.runtime.MessageSender, id), false);
  }
});

test('background page fetch targets the originating exact document and preserves validated redirect base', async context => {
  const { store, job } = fixture();
  const api = browser(context, { getFrame: async details => {
    assert.deepEqual(details, { tabId: 1, frameId: 7 });
    return { documentId: 'doc-frame', frameId: 7, url: 'https://player.test/embed', documentLifecycle: 'active' };
  }, sendMessage: async (tabId, message, options) => {
    assert.equal(tabId, 1);
    const request = message as { type: string; url: string; requestId: string; expiresAt: number };
    assert.equal(request.type, 'fetch-manifest');
    assert.equal(request.url, 'https://cdn.test/master.m3u8?signature=a%2Fb');
    assert.match(request.requestId, /^[a-zA-Z0-9_-]{1,128}$/);
    assert.ok(request.expiresAt > Date.now() && request.expiresAt <= Date.now() + 4_500);
    assert.deepEqual(options, { frameId: 7, documentId: 'doc-frame' });
    return { ok: true, url: 'https://cdn.test/final/list.m3u8', text: HLS, status: 200 };
  } });
  const original = api.webNavigation.getFrame;
  api.webNavigation.getFrame = async function (this: unknown, details) { assert.equal(this, api.webNavigation); return original(details); };
  const received = await createPageManifestFetcher(store)(job, new AbortController().signal);
  assert.equal(received.url, 'https://cdn.test/final/list.m3u8');
  assert.equal(await received.text(), HLS);
});

test('background page fetch rejects stale job epochs before messaging a document', async context => {
  const { store, job } = fixture();
  browser(context, { sendMessage: async () => assert.fail('stale job reached document') });
  await store.dispatch(s => navigate(s, 1, 'https://page.test/new', 4, 'doc-new'));
  await assert.rejects(createPageManifestFetcher(store)(job, new AbortController().signal), /stale|document/);
});

test('background page fetch rejects a getFrame result whose document no longer matches', async context => {
  const { store, job } = fixture();
  browser(context, { getFrame: async () => ({ documentId: 'doc-new', frameId: 7, url: 'https://player.test/new' }),
    sendMessage: async () => assert.fail('replaced document received old request') });
  await assert.rejects(createPageManifestFetcher(store)(job, new AbortController().signal), /document|stale/);
});

test('background page fetch rejects a document replaced while getFrame is pending', async context => {
  const { store, job } = fixture();
  const lookup = deferred<unknown>();
  browser(context, { getFrame: () => lookup.promise, sendMessage: async () => assert.fail('stale lookup reached document') });
  const fetching = createPageManifestFetcher(store)(job, new AbortController().signal);
  const rejected = assert.rejects(fetching, /stale|document/);
  await tick();
  await store.dispatch(s => bindDocument(s, 1, 7, 'doc-new'));
  lookup.resolve({ documentId: 'doc-frame', frameId: 7, url: 'https://player.test/embed' });
  await rejected;
});

test('a grouped child delegates to its own frame instead of an unrelated owner frame', async context => {
  const { store, job } = fixture();
  const url = 'https://cdn.test/1080/playlist.jpg';
  await store.dispatch(s => {
    const next = structuredClone(s);
    const item = next.tabs[1].media[job.itemId];
    item.frameIds = [0, 7];
    item.childUrls = [url];
    item.childManifests = [{ url, status: 'observed', instance: 55, frameIds: [7] }];
    return next;
  });
  browser(context, { getFrame: async details => {
    assert.equal(details.frameId, 7);
    return { documentId: 'doc-frame', frameId: 7, url: 'https://player.test/embed' };
  } });
  const received = await createPageManifestFetcher(store)({ ...job, itemId: url, url, instance: 55 }, new AbortController().signal);
  assert.equal(await received.text(), HLS);
});

test('shared media can use another current originating frame when the first context fails CORS', async context => {
  const { store, job } = fixture();
  await store.dispatch(s => {
    const next = structuredClone(s);
    next.tabs[1].media[job.itemId].frameIds = [0, 7];
    return next;
  });
  browser(context, { getFrame: async details => ({ frameId: details.frameId,
    documentId: details.frameId === 0 ? 'doc-a' : 'doc-frame', url: details.frameId === 0 ? 'https://page.test/' : 'https://player.test/embed' }),
  sendMessage: async (_tabId, _message, options) => (options as { frameId: number }).frameId === 0
    ? { ok: false, error: 'Failed to fetch' }
    : { ok: true, url: 'https://cdn.test/list.m3u8', text: HLS, status: 200 } });
  assert.equal(await (await createPageManifestFetcher(store)(job, new AbortController().signal)).text(), HLS);
});

test('background page fetch drops a reply when its originating frame navigates while pending', async context => {
  const { store, job } = fixture();
  const pending = deferred<unknown>();
  browser(context, { sendMessage: () => pending.promise });
  const fetching = createPageManifestFetcher(store)(job, new AbortController().signal);
  await tick();
  await store.dispatch(s => bindDocument(s, 1, 7, 'doc-new'));
  pending.resolve({ ok: true, url: 'https://cdn.test/list.m3u8', text: HLS, status: 200 });
  await assert.rejects(fetching, /stale|document/);
});

test('background page fetch rejects malformed, excessive and unsuccessful replies', async context => {
  const { store, job } = fixture();
  let reply: unknown;
  browser(context, { sendMessage: async () => reply });
  const fetcher = createPageManifestFetcher(store);
  for (reply of [undefined, [], { ok: true, url: 'https://cdn.test/list', text: HLS, status: 404 },
    { ok: true, url: 'file:///private', text: HLS, status: 200 },
    { ok: true, url: 'https://cdn.test/list', text: 'a'.repeat(2 * 1024 * 1024 + 1), status: 200 },
    { ok: true, url: 'https://cdn.test/list', text: '\ud800', status: 200 }, { ok: false, error: 'cors-failed' }]) {
    await assert.rejects(fetcher(job, new AbortController().signal));
  }
});

test('background abort rejects even when tabs.sendMessage stays pending', async context => {
  const { store, job } = fixture();
  browser(context, { sendMessage: () => new Promise(() => {}) });
  const controller = new AbortController();
  const fetching = createPageManifestFetcher(store)(job, controller.signal);
  await tick();
  controller.abort(new Error('test-abort'));
  await assert.rejects(fetching, /test-abort|abort/);
});
