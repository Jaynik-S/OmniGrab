import assert from 'node:assert/strict';
import test from 'node:test';
import { createDownloadAttachmentHandler } from '../src/content/download-fetch.ts';
import { createDownloadTransport } from '../src/downloads/transport.ts';
import { connectPair, selection, attachPage } from './download-transport-fixtures.ts';

test('content rejects untrusted sender, expired and replayed capabilities before any network request', () => {
  let connections = 0, fetches = 0; const handler = createDownloadAttachmentHandler('test', { fetcher: async () => { fetches++; return new Response('bad'); }, connect: name => { connections++; return connectPair(name).page; } });
  const payload = { type: 'download-attach', jobId: 'j', capability: 'b'.repeat(48), selection, expiresAt: Date.now() + 5000 };
  const replies: unknown[] = [];
  for (const sender of [{ id: 'other' }, { id: 'test', tab: { id: 7 } }, { id: 'test', url: 'https://page.test/' }]) handler(payload, sender as chrome.runtime.MessageSender, value => replies.push(value));
  assert.equal(connections, 0);
  handler({ ...payload, expiresAt: Date.now() - 1 }, { id: 'test', url: 'chrome-extension://test/background.js' }, value => replies.push(value));
  assert.equal(connections, 0);
  handler(payload, { id: 'test', url: 'chrome-extension://test/background.js' }, value => replies.push(value));
  handler(payload, { id: 'test', url: 'chrome-extension://test/background.js' }, value => replies.push(value));
  assert.equal(connections, 1); assert.equal(fetches, 0); assert.deepEqual(replies.at(-1), { ok: false, error: 'download-attachment-invalid' });
});

test('host rejects wrong actual document/frame/tab sender and duplicate or out-of-order chunks', async () => {
  for (const binding of [{ documentId: 'old' }, { frameId: 8 }, { tab: { id: 9 } }, { id: 'other' }]) {
    const t = createDownloadTransport({ jobId: 'binding', selection, runtimeId: 'test', validateDocument: async () => true });
    const payload = t.expectAttachment('c'.repeat(48)); const pair = connectPair('download-binary-v1:' + JSON.stringify({ jobId: 'binding', capability: payload.capability }));
    Object.assign(pair.host.sender!, binding); assert.equal(await t.acceptPort(pair.host), false); await t.dispose();
  }
  for (const sequence of [1, 0]) {
    const t = createDownloadTransport({ jobId: 'order', selection, runtimeId: 'test', validateDocument: async () => true, fetcher: async () => new Response(null, { status: 404 }) });
    const payload = t.expectAttachment('d'.repeat(48)); const pair = connectPair('download-binary-v1:' + JSON.stringify({ jobId: 'order', capability: payload.capability }));
    pair.page.onMessage.addListener((value: unknown) => {
      const m = value as { type: string; requestId: string; jobId: string };
      if (m.type === 'grants') pair.page.postMessage({ type: 'ready', jobId: m.jobId });
      if (m.type === 'request') {
        pair.page.postMessage({ type: 'headers', jobId: m.jobId, requestId: m.requestId, status: 200, url: selection.sourceUrl, redirected: false, headers: [] });
        const chunk = { type: 'chunk', jobId: m.jobId, requestId: m.requestId, sequence, offset: 0, bytes: 1, data: 'AQ==' };
        pair.page.postMessage(chunk); if (sequence === 0) pair.page.postMessage(chunk);
      }
      if (m.type === 'abort') pair.page.postMessage({ type: 'error', jobId: m.jobId, requestId: m.requestId, error: 'download-aborted' });
    });
    await t.acceptPort(pair.host); const response = await t.fetch(selection.sourceUrl);
    await assert.rejects(response.arrayBuffer(), /order/); await t.dispose();
  }
});

test('page disconnect quarantines physical slots until a trusted explicit detach receipt', async () => {
  const t = createDownloadTransport({ jobId: 'disconnect', selection, runtimeId: 'test', validateDocument: async () => true, fetcher: async () => new Response(null, { status: 404 }) });
  const pair = await attachPage(t, async (_input, init) => new Response(new ReadableStream({ start(c) { init?.signal?.addEventListener('abort', () => c.error(new Error('aborted'))); c.enqueue(new Uint8Array([1])); } })));
  const response = await t.fetch(selection.sourceUrl); const read = response.arrayBuffer(); pair.host.disconnect();
  await assert.rejects(read, /disconnected/); await t.dispose();
  assert.equal(t.metrics.active, 1); assert.equal(t.metrics.quarantined, 1);
  assert.throws(() => t.confirmAttachmentStopped('wrong'), /attachment/);
  t.confirmAttachmentStopped('a'.repeat(48)); assert.equal(t.metrics.active, 0); assert.equal(t.metrics.quarantined, 0);
});

test('content detach waits for actual body cancellation before acknowledging settlement', async () => {
  let canceled = false, release!: () => void; const cancellation = new Promise<void>(resolve => { release = resolve; });
  let pair!: ReturnType<typeof connectPair>;
  const handler = createDownloadAttachmentHandler('test', { connect: name => { pair = connectPair(name); return pair.page; }, fetcher: async () => new Response(new ReadableStream({ cancel: async () => { await cancellation; canceled = true; } })) });
  const payload = { type: 'download-attach', jobId: 'detach', capability: 'e'.repeat(48), selection, expiresAt: Date.now() + 5000 }; const sender = { id: 'test', url: 'chrome-extension://test/background.js' };
  handler(payload, sender, () => {});
  pair.host.postMessage({ type: 'grants', jobId: 'detach', grants: [] });
  pair.host.postMessage({ type: 'request', jobId: 'detach', requestId: 'r', url: selection.sourceUrl, maxBytes: 2097152, idleMs: 1000, expiresAt: Date.now() + 2000 });
  await new Promise(resolve => setTimeout(resolve, 10)); let receipt: unknown;
  const handled = handler({ type: 'download-detach', jobId: 'detach', capability: payload.capability }, sender, value => { receipt = value; });
  assert.equal(handled, true); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(receipt, undefined);
  release(); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(canceled, true);
  assert.deepEqual(receipt, { ok: true, jobId: 'detach', capability: payload.capability, settled: true });
});

test('host validates range metadata independently of page message claims', async () => {
  const t = createDownloadTransport({ jobId: 'headers', selection, runtimeId: 'test', validateDocument: async () => true, fetcher: async () => new Response(null, { status: 404 }) });
  const payload = t.expectAttachment('f'.repeat(48)); const pair = connectPair('download-binary-v1:' + JSON.stringify({ jobId: 'headers', capability: payload.capability }));
  pair.page.onMessage.addListener((value: unknown) => {
    const m = value as { type: string; jobId: string; requestId: string };
    if (m.type === 'grants') pair.page.postMessage({ type: 'ready', jobId: m.jobId });
    if (m.type === 'request') pair.page.postMessage({ type: 'headers', jobId: m.jobId, requestId: m.requestId, url: 'https://cdn.test/range', status: 206, redirected: false, headers: [['content-range', 'bytes 9-18/30'], ['content-length', '10']] });
    if (m.type === 'abort') pair.page.postMessage({ type: 'error', jobId: m.jobId, requestId: m.requestId, error: 'download-aborted' });
  });
  await t.acceptPort(pair.host); t.grantResources([{ url: 'https://cdn.test/range', range: { start: 10, end: 19 } }]);
  await assert.rejects(t.fetch('https://cdn.test/range', { headers: { Range: 'bytes=10-19' } }), /range/); await t.dispose();
});

test('detach fences late port requests while physical cancellation remains unsettled', async () => {
  let release!: () => void, fetches = 0, pair!: ReturnType<typeof connectPair>;
  const cancellation = new Promise<void>(resolve => { release = resolve; });
  const handler = createDownloadAttachmentHandler('test', { connect: name => { pair = connectPair(name); return pair.page; }, fetcher: async () => { fetches++; return new Response(new ReadableStream({ cancel: () => cancellation })); } });
  const payload = { type: 'download-attach', jobId: 'fence', capability: 'g'.repeat(48), selection, expiresAt: Date.now() + 5000 }; const sender = { id: 'test', url: 'chrome-extension://test/background.js' };
  handler(payload, sender, () => {}); pair.host.postMessage({ type: 'grants', jobId: 'fence', grants: [] });
  const request = { type: 'request', jobId: 'fence', requestId: 'r1', url: selection.sourceUrl, maxBytes: 2097152, idleMs: 100, expiresAt: Date.now() + 1000 };
  pair.host.postMessage(request); await new Promise(resolve => setTimeout(resolve, 10));
  handler({ type: 'download-detach', jobId: 'fence', capability: payload.capability }, sender, () => {});
  pair.host.postMessage({ ...request, requestId: 'r2' }); await new Promise(resolve => setTimeout(resolve, 10)); release();
  assert.equal(fetches, 1);
});

test('content accepts a coordinator-targeted nonzero frame while preserving top-level pageUrl', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://embed.test/player' } });
  try {
    let connected = false, receipt: unknown;
    const handler = createDownloadAttachmentHandler('test', { connect: name => { connected = true; return connectPair(name).page; } });
    handler({ type: 'download-attach', jobId: 'iframe', capability: 'h'.repeat(48), selection: { ...selection, frameId: 7, pageUrl: 'https://page.test/watch' }, expiresAt: Date.now() + 5000 }, { id: 'test', url: 'chrome-extension://test/background.js' }, value => { receipt = value; });
    assert.deepEqual(receipt, { ok: true }); assert.equal(connected, true);
  } finally {
    if (original) Object.defineProperty(globalThis, 'location', original); else Reflect.deleteProperty(globalThis, 'location');
  }
});

for (const phase of ['live', 'settling'] as const) test(`128 settled capabilities cannot replace an original ${phase} physical session`, async () => {
  let originalPair!: ReturnType<typeof connectPair>, connections = 0, physical = 0, cancellations = 0, release!: () => void;
  const cancellation = new Promise<void>(resolve => { release = resolve; });
  const sender = { id: 'test', url: 'chrome-extension://test/background.js' };
  const capability = 'original_'.padEnd(48, 'x'); let receipt: unknown;
  const handler = createDownloadAttachmentHandler('test', {
    connect: name => { const pair = connectPair(name); if (!connections) originalPair = pair; connections++; return pair.page; },
    fetcher: async () => { physical++; return new Response(new ReadableStream({ cancel: async () => { cancellations++; await cancellation; physical--; } })); },
  });
  const payload = { type: 'download-attach', jobId: 'original', capability, selection, expiresAt: Date.now() + 5000 };
  handler(payload, sender, value => { receipt = value; }); assert.deepEqual(receipt, { ok: true });
  originalPair.host.postMessage({ type: 'grants', jobId: 'original', grants: [] });
  originalPair.host.postMessage({ type: 'request', jobId: 'original', requestId: 'r', url: selection.sourceUrl, maxBytes: 2097152, idleMs: 15000, expiresAt: Date.now() + 120000 });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(physical, 1);
  let detached: unknown;
  if (phase === 'settling') handler({ type: 'download-detach', jobId: 'original', capability }, sender, value => { detached = value; });
  for (let index = 0; index < 128; index++) {
    const other = `other_${index}`.padEnd(48, 'x'), jobId = `other${index}`;
    handler({ ...payload, jobId, capability: other, expiresAt: Date.now() + 5000 }, sender, value => { receipt = value; }); assert.deepEqual(receipt, { ok: true });
    await new Promise<void>(resolve => { handler({ type: 'download-detach', jobId, capability: other }, sender, () => resolve()); });
  }
  handler({ ...payload, expiresAt: Date.now() + 5000 }, sender, value => { receipt = value; });
  const replay = receipt;
  // Always settle the retained underlying stream, including on the RED replay path.
  handler({ type: 'download-detach', jobId: 'original', capability }, sender, value => { detached = value; });
  await new Promise(resolve => setTimeout(resolve, 10));
  const beforeRelease = { detached, physical, cancellations, connections };
  originalPair.host.disconnect(); release(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(replay, { ok: false, error: 'download-attachment-invalid' });
  assert.equal(beforeRelease.connections, 129); assert.equal(beforeRelease.physical, 1); assert.equal(beforeRelease.cancellations, 1); assert.equal(beforeRelease.detached, undefined);
  assert.equal(physical, 0); assert.deepEqual(detached, { ok: true, jobId: 'original', capability, settled: true });
});
