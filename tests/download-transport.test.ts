import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createDownloadTransport } from '../src/downloads/transport.ts';
import { decodeChunk } from '../src/downloads/binary-protocol.ts';
import { connectPair, selection, attachPage } from './download-transport-fixtures.ts';

test('reuses a successfully completed page origin for the next granted resource', async () => {
  let primaryCalls = 0, pageCalls = 0;
  const transport = createDownloadTransport({ jobId: 'proven-page', selection, runtimeId: 'test', validateDocument: async () => true,
    fetcher: async () => { primaryCalls++; return new Response(null, { status: 404 }); } });
  await attachPage(transport, async () => { pageCalls++; return new Response(new Uint8Array([4, 5, 6])); });
  transport.grantResources([{ url: 'https://cdn.test/a' }, { url: 'https://cdn.test/b' }]);
  try {
    for (const url of ['https://cdn.test/a', 'https://cdn.test/b']) assert.deepEqual([...new Uint8Array(await (await transport.fetch(url)).arrayBuffer())], [4, 5, 6]);
    assert.equal(primaryCalls, 1); assert.equal(pageCalls, 2); assert.equal(transport.metrics.attempts, 3);
    assert.equal(transport.metrics.active, 0); assert.equal(transport.metrics.queuedBytes, 0);
  } finally { await transport.dispose(); }
});

test('page headers alone do not establish an origin hint', async () => {
  let primaryCalls = 0;
  const transport = createDownloadTransport({ jobId: 'headers-not-proof', selection, runtimeId: 'test', validateDocument: async () => true,
    fetcher: async () => { primaryCalls++; return new Response(null, { status: 404 }); } });
  await attachPage(transport, async () => new Response(new Uint8Array([4, 5, 6])));
  transport.grantResources([{ url: 'https://cdn.test/a' }, { url: 'https://cdn.test/b' }]);
  try {
    const first = await transport.fetch('https://cdn.test/a');
    assert.deepEqual([...new Uint8Array(await (await transport.fetch('https://cdn.test/b')).arrayBuffer())], [4, 5, 6]);
    assert.equal(primaryCalls, 2, 'the unconsumed first body has not proved the page route');
    assert.deepEqual([...new Uint8Array(await first.arrayBuffer())], [4, 5, 6]);
  } finally { await transport.dispose(); }
});

test('proven page origins stay isolated to their origin and transport job', async () => {
  const transports: ReturnType<typeof createDownloadTransport>[] = [];
  try {
    for (const jobId of ['origin-first', 'origin-new-job']) {
      const direct: string[] = [];
      const transport = createDownloadTransport({ jobId, selection, runtimeId: 'test', validateDocument: async () => true,
        fetcher: async input => { direct.push(String(input)); return new Response(null, { status: 404 }); } });
      transports.push(transport);
      await attachPage(transport, async () => new Response(new Uint8Array([9])));
      transport.grantResources([{ url: 'https://cdn.test/a' }, { url: 'https://other.test/b' }]);
      for (const url of ['https://cdn.test/a', 'https://other.test/b']) assert.deepEqual([...new Uint8Array(await (await transport.fetch(url)).arrayBuffer())], [9]);
      assert.deepEqual(direct, ['https://cdn.test/a', 'https://other.test/b']);
    }
  } finally { for (const transport of transports) await transport.dispose(); }
});

test('a proven page origin still requires the exact resource grant and current document', async () => {
  let current = true, primaryCalls = 0, pageCalls = 0;
  const transport = createDownloadTransport({ jobId: 'hint-authorization', selection, runtimeId: 'test', validateDocument: async () => current,
    fetcher: async () => { primaryCalls++; return new Response(null, { status: 404 }); } });
  await attachPage(transport, async () => { pageCalls++; return new Response(new Uint8Array([4])); });
  try {
    assert.deepEqual([...new Uint8Array(await (await transport.fetch(selection.sourceUrl)).arrayBuffer())], [4]);
    await assert.rejects(transport.fetch('https://cdn.test/ungranted'), /grant/);
    current = false; await assert.rejects(transport.fetch(selection.videoUrl!), /stale-document/);
    assert.equal(primaryCalls, 1); assert.equal(pageCalls, 1); assert.equal(transport.metrics.attempts, 2);
  } finally { await transport.dispose(); }
});

test('a failed page body is terminal and its error cleanup does not establish a hint', async () => {
  const order: string[] = [];
  const transport = createDownloadTransport({ jobId: 'failed-page-body', selection, runtimeId: 'test', validateDocument: async () => true,
    fetcher: async input => { order.push(`primary:${input}`); return new Response(null, { status: 404 }); } });
  await attachPage(transport, async input => { order.push(`page:${input}`); return new Response(new Uint8Array([4]), { headers: { 'content-length': String(String(input).endsWith('/a') ? 2 : 1) } }); });
  transport.grantResources([{ url: 'https://cdn.test/a' }, { url: 'https://cdn.test/b' }]);
  try {
    await assert.rejects(transport.fetch('https://cdn.test/a').then(r => r.arrayBuffer()), /body-truncated/);
    assert.deepEqual(order, ['primary:https://cdn.test/a', 'page:https://cdn.test/a']);
    assert.deepEqual([...new Uint8Array(await (await transport.fetch('https://cdn.test/b')).arrayBuffer())], [4]);
    assert.deepEqual(order, ['primary:https://cdn.test/a', 'page:https://cdn.test/a', 'primary:https://cdn.test/b', 'page:https://cdn.test/b']);
    assert.equal(transport.metrics.active, 0); assert.equal(transport.metrics.queuedBytes, 0);
  } finally { await transport.dispose(); }
});

for (const failure of [401, 403, 404, 410, 503, 'network'] as const) test(`a preferred page pre-header ${failure} failure clears its hint before primary recovery`, async () => {
  const order: string[] = [];
  const transport = createDownloadTransport({ jobId: 'hint-recovery', selection, runtimeId: 'test', validateDocument: async () => true,
    fetcher: async input => { order.push(`primary:${input}`); return String(input).endsWith('/a') ? new Response(null, { status: 404 }) : new Response(new Uint8Array([7])); } });
  await attachPage(transport, async input => {
    order.push(`page:${input}`);
    if (String(input).endsWith('/a')) return new Response(new Uint8Array([7]));
    if (failure === 'network') throw new TypeError('Failed to fetch');
    return new Response(null, { status: failure });
  });
  transport.grantResources(['a', 'b', 'c'].map(name => ({ url: `https://cdn.test/${name}` })));
  try {
    for (const name of ['a', 'b', 'c']) assert.deepEqual([...new Uint8Array(await (await transport.fetch(`https://cdn.test/${name}`)).arrayBuffer())], [7]);
    assert.deepEqual(order, ['primary:https://cdn.test/a', 'page:https://cdn.test/a', 'page:https://cdn.test/b', 'primary:https://cdn.test/b', 'primary:https://cdn.test/c']);
    assert.equal(transport.metrics.attempts, 5);
  } finally { await transport.dispose(); }
});

for (const status of [408, 429]) test(`preferred-page HTTP ${status} retries stay on the page route`, async () => {
  const order: string[] = []; let bCalls = 0;
  const transport = createDownloadTransport({ jobId: 'hint-throttle', selection, runtimeId: 'test', validateDocument: async () => true,
    fetcher: async input => { order.push(`primary:${input}`); return new Response(null, { status: 404 }); } });
  await attachPage(transport, async input => { order.push(`page:${input}`); return String(input).endsWith('/b') && ++bCalls === 1 ? new Response(null, { status }) : new Response(new Uint8Array([7])); });
  transport.grantResources(['a', 'b', 'c'].map(name => ({ url: `https://cdn.test/${name}` })));
  try {
    for (const name of ['a', 'b', 'c']) assert.deepEqual([...new Uint8Array(await (await transport.fetch(`https://cdn.test/${name}`)).arrayBuffer())], [7]);
    assert.deepEqual(order, ['primary:https://cdn.test/a', 'page:https://cdn.test/a', 'page:https://cdn.test/b', 'page:https://cdn.test/b', 'page:https://cdn.test/c']);
  } finally { await transport.dispose(); }
});

test('preferred-page invalidation and fallback share the existing three-attempt budget', async () => {
  const order: string[] = [];
  const transport = createDownloadTransport({ jobId: 'hint-budget', selection, runtimeId: 'test', validateDocument: async () => true,
    fetcher: async input => { order.push(`primary:${input}`); return new Response(null, { status: 404 }); } });
  await attachPage(transport, async input => { order.push(`page:${input}`); return String(input).endsWith('/a') ? new Response(new Uint8Array([7])) : new Response(null, { status: 503 }); });
  transport.grantResources(['a', 'b'].map(name => ({ url: `https://cdn.test/${name}` })));
  try {
    await (await transport.fetch('https://cdn.test/a')).arrayBuffer();
    await assert.rejects(transport.fetch('https://cdn.test/b'), /503/);
    assert.deepEqual(order, ['primary:https://cdn.test/a', 'page:https://cdn.test/a', 'page:https://cdn.test/b', 'primary:https://cdn.test/b', 'page:https://cdn.test/b']);
    assert.equal(transport.metrics.attempts, 5); assert.equal(transport.metrics.active, 0); assert.equal(transport.metrics.queuedBytes, 0);
  } finally { await transport.dispose(); }
});

test('preserves binary MIME, final URL, status and bounded downstream backpressure across page fallback', async () => {
  const bytes = Uint8Array.from({ length: 900_001 }, (_, i) => i % 251);
  const transport = createDownloadTransport({ jobId: 'j1', selection, runtimeId: 'test', fetcher: async () => new Response(null, { status: 404 }), validateDocument: async () => true });
  const seen: RequestInit[] = [];
  await attachPage(transport, async (_input, init) => { seen.push(init!); const r = new Response(bytes, { headers: { 'content-type': 'image/jpeg', 'content-length': String(bytes.length) } }); Object.defineProperty(r, 'url', { value: 'https://cdn.test/final.jpg?token=x' }); return r; });
  transport.grantResources([{ url: 'https://cdn.test/segment.jpg' }]);
  const response = await transport.fetch('https://cdn.test/segment.jpg', { credentials: 'include', headers: { authorization: 'secret' } });
  assert.equal(response.status, 200); assert.equal(response.url, 'https://cdn.test/final.jpg?token=x');
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(transport.metrics.maximumUnacknowledgedPerRequest <= 1);
  assert.ok(transport.metrics.maximumQueuedBytes <= 8 * 1024 * 1024);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.equal(seen[0].credentials, 'same-origin'); assert.equal(new Headers(seen[0].headers).get('authorization'), null);
  await transport.dispose(); assert.equal(transport.metrics.active, 0); assert.equal(transport.metrics.queuedBytes, 0);
});

test('validates exact inclusive ranges without relabeling truthful whole-object 200', async () => {
  for (const [status, range, accept] of [[206, 'bytes 10-19/30', true], [206, 'bytes 9-18/30', false], [200, null, false]] as const) {
    const transport = createDownloadTransport({ jobId: 'range', selection, validateDocument: async () => true,
      fetcher: async () => new Response(new Uint8Array(10), { status, headers: { 'content-length': '10', ...(range ? { 'content-range': range } : {}) } }) });
    transport.grantResources([{ url: 'https://cdn.test/range', range: { start: 10, end: 19 } }]);
    const operation = transport.fetch('https://cdn.test/range', { headers: { Range: 'bytes=10-19' } }).then(r => r.arrayBuffer());
    if (accept) assert.equal((await operation).byteLength, 10); else await assert.rejects(operation, /range/);
    await transport.dispose();
  }
  const t = createDownloadTransport({ jobId: 'whole', selection, validateDocument: async () => true, fetcher: async () => new Response(new Uint8Array(30), { headers: { 'content-length': '30' } }) });
  t.grantResources([{ url: 'https://cdn.test/whole' }]);
  const r = await t.fetch('https://cdn.test/whole', { headers: { Range: 'bytes=0-9' } }); assert.equal(r.status, 200); assert.equal((await r.arrayBuffer()).byteLength, 30); await t.dispose();
});

test('rejects stale document, unauthorized grants, failed fallback and replayed attachment', async () => {
  const t = createDownloadTransport({ jobId: 'stale', selection, validateDocument: async () => false });
  await assert.rejects(t.fetch(selection.sourceUrl), /stale/);
  await assert.rejects(t.fetch('https://evil.test/'), /grant/); await t.dispose();
  const t2 = createDownloadTransport({ jobId: 'failure', selection, runtimeId: 'test', validateDocument: async () => true, fetcher: async () => new Response(null, { status: 404 }) });
  const pair = await attachPage(t2, async () => new Response(null, { status: 403 }));
  assert.equal(await t2.acceptPort(pair.host), false);
  await assert.rejects(t2.fetch(selection.sourceUrl), /403/); await t2.dispose();
});

test('physical abort retains slots until real fetch/body settlement and bounds concurrent sockets', async () => {
  let active = 0, maximum = 0, closed = 0;
  const server = createServer((_q, r) => { active++; maximum = Math.max(maximum, active); r.writeHead(200, { 'content-length': '1000000' }); r.flushHeaders(); r.write(new Uint8Array(1024)); r.on('close', () => { active--; closed++; }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number }; const url = `http://127.0.0.1:${address.port}/x`;
  const t = createDownloadTransport({ jobId: 'abort', selection: { ...selection, sourceUrl: url }, validateDocument: async () => true, idleMs: 1000, requestMs: 3000 });
  try {
    const promises = Array.from({ length: 8 }, () => t.fetch(url).then(async r => { await r.arrayBuffer(); }).catch(() => {}));
    await new Promise(resolve => setTimeout(resolve, 100)); await t.abort(); await Promise.all(promises);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(maximum <= 4); assert.ok(t.metrics.maximumActive <= 4); assert.equal(active, 0); assert.equal(closed, 4);
    assert.equal(t.metrics.active, 0); assert.equal(t.metrics.queuedBytes, 0);
  } finally { await t.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('rejects oversized base64 before decoding and rejects malformed sequence envelopes', () => {
  assert.throws(() => decodeChunk({ type: 'chunk', jobId: 'j', requestId: 'r', sequence: 0, offset: 0, data: 'A'.repeat(349_532), bytes: 262_145 }), /chunk/);
  assert.throws(() => decodeChunk({ type: 'chunk', jobId: 'j', requestId: 'r', sequence: -1, offset: 0, data: 'AQ==', bytes: 1 }), /chunk/);
  assert.deepEqual(decodeChunk({ type: 'chunk', jobId: 'j', requestId: 'r', sequence: 0, offset: 0, data: 'AP8=', bytes: 2 }), new Uint8Array([0, 255]));
});

test('preheader retry budget is three total attempts and a failed body is never resumed unsafely', async () => {
  let attempts = 0;
  const t = createDownloadTransport({ jobId: 'retries', selection, validateDocument: async () => true, fetcher: async () => { attempts++; return new Response(null, { status: 503 }); } });
  await assert.rejects(t.fetch(selection.sourceUrl), /503/); assert.equal(attempts, 3); assert.equal(t.metrics.attempts, 3); await t.dispose();
  attempts = 0;
  const broken = createDownloadTransport({ jobId: 'broken', selection, validateDocument: async () => true, fetcher: async () => { attempts++; return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.error(new Error('network body broken')); } }), { headers: { 'content-length': '10' } }); } });
  const response = await broken.fetch(selection.sourceUrl); await assert.rejects(response.arrayBuffer(), /body broken/); assert.equal(attempts, 1); await broken.dispose();
});

test('trusted resolver manifest expansion remains bounded to2MiB and cannot be widened by caller headers', async () => {
  let remaining = 2097153;
  const t = createDownloadTransport({ jobId: 'manifest', selection, validateDocument: async () => true, fetcher: async () => new Response(new ReadableStream({ pull(c) { if (!remaining) { c.close(); return; } const count = Math.min(262144, remaining); remaining -= count; c.enqueue(new Uint8Array(count)); } }), { headers: { 'content-length': '2097153' } }) });
  const child = 'https://cdn.test/fresh-highest.m3u8'; t.grantManifests([child]);
  await assert.rejects(t.fetch(child).then(r => r.arrayBuffer()), /body-limit/); assert.equal(t.metrics.active, 0); await t.dispose();
});

test('bounded BYOB reads preserve valid large coalesced native byte-stream bodies', async () => {
  const url = 'https://cdn.test/large.jpg'; let produced = 0;
  const t = createDownloadTransport({ jobId: 'byob', selection, validateDocument: async () => true, fetcher: async () => new Response(new ReadableStream({
    type: 'bytes',
    pull(controller) {
      const bytesController = controller as ReadableByteStreamController;
      if (produced === 3_000_000) { bytesController.close(); bytesController.byobRequest?.respond(0); return; }
      if (bytesController.byobRequest) {
        const view = bytesController.byobRequest.view!; const count = Math.min(view.byteLength, 3_000_000 - produced);
        new Uint8Array(view.buffer, view.byteOffset, count).fill(17); produced += count; bytesController.byobRequest.respond(count);
      } else { produced += 1_500_000; bytesController.enqueue(new Uint8Array(1_500_000).fill(17)); }
    },
  } as UnderlyingByteSource), { headers: { 'content-length': '3000000' } }) });
  t.grantResources([{ url }]);
  try { const response = await t.fetch(url); const bytes = new Uint8Array(await response.arrayBuffer()); assert.equal(bytes.length, 3_000_000); assert.ok(bytes.every(b => b === 17)); }
  finally { await t.dispose(); }
});

test('accepts browser-decoded compressed manifests while rejecting encoded media ranges', async () => {
  const text = '#EXTM3U\n#EXT-X-ENDLIST';
  const t = createDownloadTransport({ jobId: 'gzip', selection, validateDocument: async () => true, fetcher: async () => new Response(text, { headers: { 'content-encoding': 'gzip', 'content-length': '10' } }) });
  try { const response = await t.fetch(selection.sourceUrl); assert.equal(await response.text(), text); assert.equal(response.headers.get('content-encoding'), 'gzip'); }
  finally { await t.dispose(); }
  const mediaUrl = 'https://cdn.test/encoded.jpg';
  const media = createDownloadTransport({ jobId: 'encoded', selection, validateDocument: async () => true, fetcher: async () => new Response(new Uint8Array(10), { status: 206, headers: { 'content-encoding': 'gzip', 'content-length': '10', 'content-range': 'bytes 0-9/10' } }) });
  media.grantResources([{ url: mediaUrl }]);
  await assert.rejects(media.fetch(mediaUrl, { headers: { Range: 'bytes=0-9' } }), /encoding/); await media.dispose();
});
