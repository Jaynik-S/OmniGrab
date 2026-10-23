import assert from 'node:assert/strict';
import test from 'node:test';
import { createDownloadAttachmentHandler } from '../src/content/download-fetch.ts';
import { createDownloadTransport } from '../src/downloads/transport.ts';
import { connectPair, selection, attachPage } from './download-transport-fixtures.ts';

test('content rejects untrusted sender, stale page and replayed capabilities before any network request', () => {
  let connections = 0, fetches = 0; const handler = createDownloadAttachmentHandler('test', { pageUrl: () => selection.pageUrl, fetcher: async () => { fetches++; return new Response('bad'); }, connect: name => { connections++; return connectPair(name).page; } });
  const payload = { type: 'download-attach', jobId: 'j', capability: 'b'.repeat(48), selection, expiresAt: Date.now() + 5000 };
  const replies: unknown[] = [];
  for (const sender of [{ id: 'other' }, { id: 'test', tab: { id: 7 } }, { id: 'test', url: 'https://page.test/' }]) handler(payload, sender as chrome.runtime.MessageSender, value => replies.push(value));
  assert.equal(connections, 0);
  handler({ ...payload, selection: { ...selection, pageUrl: 'https://page.test/stale' } }, { id: 'test', url: 'chrome-extension://test/background.js' }, value => replies.push(value));
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
  const handler = createDownloadAttachmentHandler('test', { pageUrl: () => selection.pageUrl, connect: name => { pair = connectPair(name); return pair.page; }, fetcher: async () => new Response(new ReadableStream({ cancel: async () => { await cancellation; canceled = true; } })) });
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
  const handler = createDownloadAttachmentHandler('test', { pageUrl: () => selection.pageUrl, connect: name => { pair = connectPair(name); return pair.page; }, fetcher: async () => { fetches++; return new Response(new ReadableStream({ cancel: () => cancellation })); } });
  const payload = { type: 'download-attach', jobId: 'fence', capability: 'g'.repeat(48), selection, expiresAt: Date.now() + 5000 }; const sender = { id: 'test', url: 'chrome-extension://test/background.js' };
  handler(payload, sender, () => {}); pair.host.postMessage({ type: 'grants', jobId: 'fence', grants: [] });
  const request = { type: 'request', jobId: 'fence', requestId: 'r1', url: selection.sourceUrl, maxBytes: 2097152, idleMs: 100, expiresAt: Date.now() + 1000 };
  pair.host.postMessage(request); await new Promise(resolve => setTimeout(resolve, 10));
  handler({ type: 'download-detach', jobId: 'fence', capability: payload.capability }, sender, () => {});
  pair.host.postMessage({ ...request, requestId: 'r2' }); await new Promise(resolve => setTimeout(resolve, 10)); release();
  assert.equal(fetches, 1);
});
