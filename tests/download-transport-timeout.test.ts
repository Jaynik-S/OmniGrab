import assert from 'node:assert/strict';
import test from 'node:test';
import { createDownloadTransport } from '../src/downloads/transport.ts';
import { attachPage, selection } from './download-transport-fixtures.ts';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const bytes = new Uint8Array([0, 255, 17, 128, 1, 91]);
const response = () => new Response(bytes, { headers: { 'content-type': 'image/jpeg', 'content-length': String(bytes.length) } });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('test physical-state deadline'); await sleep(2); }
}
function physical() {
  const state = { active: 0, maximum: 0, starts: 0, aborted: 0, settled: 0 };
  const start = () => { state.starts++; state.active++; state.maximum = Math.max(state.maximum, state.active); };
  const stall = (gate: Promise<void> = Promise.resolve()): typeof fetch => async (_input, init) => {
    start(); const signal = init!.signal!;
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => { state.aborted++; void gate.then(() => { state.active--; state.settled++; reject(signal.reason); }); };
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    });
  };
  const succeed: typeof fetch = async () => { start(); state.active--; state.settled++; return response(); };
  return { state, stall, succeed };
}

test('a preferred page idle timeout waits for physical settlement before clearing its hint and recovering directly', async () => {
  const page = physical(), gate = deferred(), order: string[] = [];
  const transport = createDownloadTransport({ jobId: 'hint-idle-recover', selection, runtimeId: 'test', idleMs: 25, requestMs: 2000, validateDocument: async () => true,
    fetcher: async input => { order.push(`primary:${input}`); assert.equal(page.state.active, 0); return String(input).endsWith('/a') ? new Response(null, { status: 404 }) : response(); } });
  await attachPage(transport, (input, init) => { order.push(`page:${input}`); return String(input).endsWith('/a') ? page.succeed(input, init) : page.stall(gate.promise)(input, init); });
  transport.grantResources(['a', 'b', 'c'].map(name => ({ url: `https://cdn.test/${name}` })));
  let pending: Promise<ArrayBuffer> | undefined;
  try {
    assert.deepEqual(new Uint8Array(await (await transport.fetch('https://cdn.test/a')).arrayBuffer()), bytes);
    pending = transport.fetch('https://cdn.test/b').then(r => r.arrayBuffer());
    await until(() => page.state.aborted === 1); await sleep(15);
    assert.deepEqual(order, ['primary:https://cdn.test/a', 'page:https://cdn.test/a', 'page:https://cdn.test/b']);
    assert.equal(transport.metrics.active, 1); assert.equal(page.state.active, 1);
    gate.resolve(); assert.deepEqual(new Uint8Array(await pending), bytes);
    assert.deepEqual(new Uint8Array(await (await transport.fetch('https://cdn.test/c')).arrayBuffer()), bytes);
    assert.deepEqual(order, ['primary:https://cdn.test/a', 'page:https://cdn.test/a', 'page:https://cdn.test/b', 'primary:https://cdn.test/b', 'primary:https://cdn.test/c']);
    assert.equal(transport.metrics.attempts, 5); assert.equal(page.state.maximum, 1);
    assert.equal(transport.metrics.active, 0); assert.equal(transport.metrics.queuedBytes, 0);
  } finally { gate.resolve(); await pending?.catch(() => {}); await transport.dispose(); }
});

for (const stop of ['caller', 'overall', 'stale', 'disconnect'] as const) test(`preferred-page idle recovery stops on ${stop} while abort settlement is pending`, async () => {
  let current = true; const page = physical(), gate = deferred(), caller = new AbortController(), order: string[] = [];
  const transport = createDownloadTransport({ jobId: 'hint-idle-stop', selection, runtimeId: 'test', idleMs: 20, requestMs: stop === 'overall' ? 120 : 2000, validateDocument: async () => current,
    fetcher: async input => { order.push(`primary:${input}`); return new Response(null, { status: 404 }); } });
  const pair = await attachPage(transport, (input, init) => { order.push(`page:${input}`); return String(input).endsWith('/a') ? page.succeed(input, init) : page.stall(gate.promise)(input, init); });
  transport.grantResources(['a', 'b'].map(name => ({ url: `https://cdn.test/${name}` })));
  let pending: Promise<Response> | undefined;
  try {
    assert.deepEqual(new Uint8Array(await (await transport.fetch('https://cdn.test/a')).arrayBuffer()), bytes);
    pending = transport.fetch('https://cdn.test/b', { signal: caller.signal });
    const rejected = assert.rejects(pending, stop === 'stale' ? /stale-document/ : stop === 'disconnect' ? /disconnected/ : stop === 'caller' ? /caller-stop/ : /TimeoutError/);
    await until(() => page.state.aborted === 1);
    if (stop === 'caller') caller.abort(new Error('caller-stop'));
    else if (stop === 'stale') current = false;
    else if (stop === 'disconnect') pair.page.disconnect();
    else await sleep(140);
    assert.equal(transport.metrics.active, 1); assert.equal(page.state.active, 1);
    assert.deepEqual(order, ['primary:https://cdn.test/a', 'page:https://cdn.test/a', 'page:https://cdn.test/b']);
    if (stop === 'disconnect') {
      await rejected; assert.equal(transport.metrics.quarantined, 1);
      gate.resolve(); await until(() => page.state.active === 0);
      assert.equal(transport.metrics.active, 1, 'uncertain lease remains quarantined after physical IO settles');
      transport.confirmAttachmentStopped('a'.repeat(48));
    } else { gate.resolve(); await rejected; }
    assert.equal(transport.metrics.attempts, 3); assert.equal(transport.metrics.active, 0); assert.equal(transport.metrics.queuedBytes, 0);
  } finally { gate.resolve(); await pending?.catch(() => {}); await transport.dispose(); }
});

test('a preferred page body timeout stays terminal without another physical attempt', async () => {
  const order: string[] = []; let canceled = 0;
  const transport = createDownloadTransport({ jobId: 'hint-body-timeout', selection, runtimeId: 'test', idleMs: 25, requestMs: 2000, validateDocument: async () => true,
    fetcher: async input => { order.push(`primary:${input}`); return new Response(null, { status: 404 }); } });
  await attachPage(transport, async input => {
    order.push(`page:${input}`);
    return String(input).endsWith('/a') ? response() : new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); }, cancel() { canceled++; } }), { headers: { 'content-length': '6' } });
  });
  transport.grantResources(['a', 'b'].map(name => ({ url: `https://cdn.test/${name}` })));
  try {
    await (await transport.fetch('https://cdn.test/a')).arrayBuffer();
    await assert.rejects(transport.fetch('https://cdn.test/b').then(r => r.arrayBuffer()), /download-timeout/);
    assert.deepEqual(order, ['primary:https://cdn.test/a', 'page:https://cdn.test/a', 'page:https://cdn.test/b']);
    assert.equal(canceled, 1); assert.equal(transport.metrics.attempts, 3);
  } finally { await transport.dispose(); }
});

test('a settled primary pre-header idle timeout falls back to the current page and returns exact bytes', async () => {
  const primary = physical(), page = physical(), gate = deferred();
  const transport = createDownloadTransport({ jobId: 'idle-page', selection, runtimeId: 'test', idleMs: 25, requestMs: 2000, validateDocument: async () => true, fetcher: primary.stall(gate.promise) });
  await attachPage(transport, async (...args) => { assert.equal(primary.state.active, 0, 'fallback must wait for physical settlement'); return page.succeed(...args); });
  const pending = transport.fetch(selection.sourceUrl).then(r => r.arrayBuffer());
  try {
    await until(() => primary.state.aborted === 1); await sleep(15);
    assert.equal(page.state.starts, 0); assert.equal(transport.metrics.active, 1);
    gate.resolve(); assert.deepEqual(new Uint8Array(await pending), bytes);
    assert.equal(primary.state.starts, 1); assert.equal(page.state.starts, 1); assert.equal(transport.metrics.attempts, 2);
  } finally { gate.resolve(); await pending.catch(() => {}); await transport.dispose(); }
});

test('without a page a settled pre-header idle timeout retries the primary once and returns exact bytes', async () => {
  const io = physical(); let calls = 0;
  const transport = createDownloadTransport({ jobId: 'idle-primary', selection, idleMs: 25, requestMs: 2000, validateDocument: async () => true, fetcher: (...args) => ++calls === 1 ? io.stall()(...args) : io.succeed(...args) });
  try { assert.deepEqual(new Uint8Array(await (await transport.fetch(selection.sourceUrl)).arrayBuffer()), bytes); assert.equal(calls, 2); assert.equal(io.state.maximum, 1); assert.equal(transport.metrics.attempts, 2); }
  finally { await transport.dispose(); }
});

test('a page pre-header idle timeout retries only after that page fetch physically settles', async () => {
  const page = physical(), gate = deferred(); let pageCalls = 0;
  const transport = createDownloadTransport({ jobId: 'idle-page-retry', selection, runtimeId: 'test', idleMs: 25, requestMs: 2000, validateDocument: async () => true, fetcher: async () => new Response(null, { status: 404 }) });
  await attachPage(transport, (...args) => ++pageCalls === 1 ? page.stall(gate.promise)(...args) : page.succeed(...args));
  const pending = transport.fetch(selection.sourceUrl).then(r => r.arrayBuffer());
  try {
    await until(() => page.state.aborted === 1); await sleep(15); assert.equal(pageCalls, 1); assert.equal(page.state.active, 1);
    gate.resolve(); assert.deepEqual(new Uint8Array(await pending), bytes);
    assert.equal(pageCalls, 2); assert.equal(page.state.maximum, 1); assert.equal(transport.metrics.attempts, 3);
  } finally { gate.resolve(); await pending.catch(() => {}); await transport.dispose(); }
});

for (const attached of [false, true]) test(`pre-header idle exhaustion stops at three total attempts (page=${attached})`, async () => {
  const primary = physical(), page = physical();
  const transport = createDownloadTransport({ jobId: 'idle-exhaust', selection, runtimeId: 'test', idleMs: 15, requestMs: 2000, validateDocument: async () => true, fetcher: primary.stall() });
  if (attached) await attachPage(transport, page.stall());
  try {
    await assert.rejects(transport.fetch(selection.sourceUrl), /^Error: download-timeout$/);
    assert.equal(transport.metrics.attempts, 3); assert.equal(primary.state.starts, attached ? 1 : 3); assert.equal(page.state.starts, attached ? 2 : 0);
    assert.equal(primary.state.active + page.state.active, 0); assert.equal(transport.metrics.active, 0); assert.equal(transport.metrics.queuedBytes, 0);
  } finally { await transport.dispose(); }
});

for (const cancellation of ['caller', 'overall', 'lifetime'] as const) test(`${cancellation} cancellation while idle abort is settling prevents recovery attempts`, async () => {
  const primary = physical(), page = physical(), gate = deferred(), caller = new AbortController();
  const transport = createDownloadTransport({ jobId: 'idle-cancel', selection, runtimeId: 'test', idleMs: 20, requestMs: cancellation === 'overall' ? 60 : 2000, validateDocument: async () => true, fetcher: primary.stall(gate.promise) });
  await attachPage(transport, page.succeed);
  const pending = transport.fetch(selection.sourceUrl, { signal: caller.signal });
  try {
    await until(() => primary.state.aborted === 1);
    let abort: Promise<void> | undefined;
    if (cancellation === 'caller') caller.abort(new Error('caller-stop'));
    else if (cancellation === 'lifetime') abort = transport.abort();
    else await sleep(80);
    assert.equal(transport.metrics.active, 1); assert.equal(page.state.starts, 0);
    gate.resolve(); await assert.rejects(pending); await abort;
    assert.equal(transport.metrics.attempts, 1); assert.equal(primary.state.active, 0); assert.equal(page.state.starts, 0);
  } finally { gate.resolve(); await pending.catch(() => {}); await transport.dispose(); }
});

test('port loss during a page idle abort quarantines the lease and never retries uncertain IO', async () => {
  const page = physical(), gate = deferred();
  const transport = createDownloadTransport({ jobId: 'idle-disconnect', selection, runtimeId: 'test', idleMs: 20, requestMs: 2000, validateDocument: async () => true, fetcher: async () => new Response(null, { status: 404 }) });
  const pair = await attachPage(transport, page.stall(gate.promise));
  const pending = transport.fetch(selection.sourceUrl);
  try {
    await until(() => page.state.aborted === 1); pair.page.disconnect(); await assert.rejects(pending, /disconnected/); await transport.dispose();
    assert.equal(transport.metrics.attempts, 2); assert.equal(transport.metrics.active, 1); assert.equal(transport.metrics.quarantined, 1); assert.equal(page.state.active, 1);
    await assert.rejects(transport.fetch(selection.sourceUrl), /disconnected/); assert.equal(page.state.starts, 1);
    gate.resolve(); await until(() => page.state.active === 0); transport.confirmAttachmentStopped('a'.repeat(48)); assert.equal(transport.metrics.active, 0);
  } finally { gate.resolve(); await pending.catch(() => {}); await transport.dispose(); }
});

test('stale document validation prevents page fallback after a physically settled idle abort', async () => {
  let current = true; const io = physical(), page = physical(), gate = deferred();
  const transport = createDownloadTransport({ jobId: 'idle-stale', selection, runtimeId: 'test', idleMs: 20, requestMs: 2000, validateDocument: async () => current, fetcher: io.stall(gate.promise) });
  await attachPage(transport, page.succeed); const pending = transport.fetch(selection.sourceUrl);
  try {
    await until(() => io.state.aborted === 1); current = false; gate.resolve(); await assert.rejects(pending, /stale/);
    assert.equal(transport.metrics.attempts, 1); assert.equal(page.state.starts, 0); assert.equal(io.state.active, 0);
  } finally { gate.resolve(); await pending.catch(() => {}); await transport.dispose(); }
});

test('post-header idle body errors remain terminal without replaying accepted bytes', async () => {
  let cancels = 0, primaryCalls = 0; const page = physical();
  const transport = createDownloadTransport({ jobId: 'idle-body', selection, runtimeId: 'test', idleMs: 20, requestMs: 2000, validateDocument: async () => true,
    fetcher: async () => { primaryCalls++; return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); }, cancel() { cancels++; } }), { headers: { 'content-length': '6' } }); } });
  await attachPage(transport, page.succeed);
  try {
    const result = await transport.fetch(selection.sourceUrl); await assert.rejects(result.arrayBuffer(), /download-timeout/);
    assert.equal(primaryCalls, 1); assert.equal(page.state.starts, 0); assert.equal(transport.metrics.attempts, 1); assert.equal(transport.metrics.receivedBytes, 3); assert.equal(cancels, 1);
  } finally { await transport.dispose(); }
});

test('generic AbortError and validation failures are not broadened into idle retries', async () => {
  for (const error of [new DOMException('arbitrary-abort', 'AbortError'), new Error('download-timeout-extra'), new Error('download-range-mismatch'), new Error('download-request-grant-invalid')]) {
    let primaryCalls = 0; const page = physical();
    const transport = createDownloadTransport({ jobId: 'idle-errors', selection, runtimeId: 'test', idleMs: 20, requestMs: 2000, validateDocument: async () => true, fetcher: async () => { primaryCalls++; throw error; } });
    await attachPage(transport, page.succeed);
    try { await assert.rejects(transport.fetch(selection.sourceUrl)); assert.equal(primaryCalls, 1); assert.equal(page.state.starts, 0); assert.equal(transport.metrics.attempts, 1); }
    finally { await transport.dispose(); }
  }
});

test('concurrent primary idle recoveries retain four global leases through page completion', async () => {
  const io = physical();
  const transport = createDownloadTransport({ jobId: 'idle-global', selection, runtimeId: 'test', idleMs: 20, requestMs: 2000, validateDocument: async () => true, fetcher: io.stall() });
  await attachPage(transport, io.succeed);
  try {
    const results = await Promise.all(Array.from({ length: 8 }, async () => new Uint8Array(await (await transport.fetch(selection.sourceUrl)).arrayBuffer())));
    for (const result of results) assert.deepEqual(result, bytes);
    assert.equal(transport.metrics.attempts, 12); assert.equal(io.state.starts, 12); assert.ok(io.state.maximum <= 4); assert.ok(transport.metrics.maximumActive <= 4);
    assert.ok(transport.metrics.maximumQueuedBytes <= 8 * 1024 * 1024); assert.equal(transport.metrics.maximumUnacknowledgedPerRequest, 1); assert.equal(transport.metrics.active, 0); assert.equal(transport.metrics.queuedBytes, 0);
  } finally { await transport.dispose(); }
});

test('rapid arrayBuffer drains accept exact bytes and send one monotonic ACK per chunk', async () => {
  const payload = Uint8Array.from({ length: 900001 }, (_, index) => index % 251);
  const transport = createDownloadTransport({ jobId: 'fast-drain', selection, runtimeId: 'test', idleMs: 1000, requestMs: 10000, validateDocument: async () => true, fetcher: async () => new Response(null, { status: 404 }) });
  const pair = await attachPage(transport, async () => new Response(payload, { headers: { 'content-length': String(payload.length) } }));
  const acks = new Map<string, Array<{ sequence: number; offset: number }>>();
  pair.page.onMessage.addListener((message: { type: string; requestId: string; sequence: number; offset: number }) => { if (message.type === 'ack') { const values = acks.get(message.requestId) ?? []; values.push({ sequence: message.sequence, offset: message.offset }); acks.set(message.requestId, values); } });
  try {
    const results = await Promise.all(Array.from({ length: 8 }, async () => new Uint8Array(await (await transport.fetch(selection.sourceUrl)).arrayBuffer())));
    for (const result of results) assert.deepEqual(result, payload);
    assert.equal(acks.size, 8);
    for (const values of acks.values()) assert.deepEqual(values, [{ sequence: 0, offset: 262144 }, { sequence: 1, offset: 524288 }, { sequence: 2, offset: 786432 }, { sequence: 3, offset: 900001 }]);
    assert.equal(transport.metrics.active, 0); assert.equal(transport.metrics.queuedBytes, 0); assert.equal(transport.metrics.maximumUnacknowledgedPerRequest, 1);
  } finally { await transport.dispose(); }
});

test('canceling a held chunk frees its queue weight without ACK or premature physical settlement', async () => {
  let canceled = 0; const gate = deferred();
  const transport = createDownloadTransport({ jobId: 'held-cancel', selection, runtimeId: 'test', idleMs: 1000, requestMs: 5000, validateDocument: async () => true, fetcher: async () => new Response(null, { status: 404 }) });
  const pair = await attachPage(transport, async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); }, async cancel() { canceled++; await gate.promise; } })));
  let acks = 0; pair.page.onMessage.addListener((message: { type: string }) => { if (message.type === 'ack') acks++; });
  try {
    const result = await transport.fetch(selection.sourceUrl); await until(() => transport.metrics.receivedBytes === 3);
    await result.body!.cancel(); await until(() => canceled === 1);
    assert.equal(acks, 0); assert.equal(transport.metrics.active, 1);
    gate.resolve(); await until(() => transport.metrics.active === 0); assert.equal(transport.metrics.queuedBytes, 0); assert.equal(acks, 0);
  } finally { gate.resolve(); await transport.dispose(); }
});

test('a rejected downstream enqueue sends no ACK and retains its lease until physical cancellation settles', async () => {
  const gate = deferred(), rejected = new Error('controlled-downstream-enqueue-rejection');
  let canceled = 0, throws = 0, acks = 0;
  const source = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
    async cancel() { canceled++; await gate.promise; },
  }));
  const transport = createDownloadTransport({ jobId: 'enqueue-rejected', selection, runtimeId: 'test', idleMs: 1000, requestMs: 5000, validateDocument: async () => true, fetcher: async () => new Response(null, { status: 404 }) });
  const pair = await attachPage(transport, async () => source);
  pair.page.onMessage.addListener((message: { type: string }) => { if (message.type === 'ack') acks++; });
  const enqueue = ReadableStreamDefaultController.prototype.enqueue;
  try {
    const result = await transport.fetch(selection.sourceUrl);
    await until(() => transport.metrics.receivedBytes === 3);
    const heldWeight = transport.metrics.queuedBytes;
    // The real producer already holds its first chunk. Only the downstream acceptance boundary throws.
    ReadableStreamDefaultController.prototype.enqueue = function () { throws++; throw rejected; };
    await assert.rejects(result.arrayBuffer(), error => error === rejected);
    ReadableStreamDefaultController.prototype.enqueue = enqueue;
    await until(() => canceled === 1);
    assert.equal(throws, 1); assert.equal(acks, 0);
    assert.ok(transport.metrics.queuedBytes < heldWeight, 'rejected chunk weight must be discarded');
    assert.equal(transport.metrics.active, 1, 'unsettled physical cancellation must retain the lease');
    gate.resolve(); await until(() => transport.metrics.active === 0);
    assert.equal(transport.metrics.queuedBytes, 0); assert.equal(acks, 0);
    assert.equal(transport.metrics.attempts, 2); assert.equal(transport.metrics.quarantined, 0);
  } finally { ReadableStreamDefaultController.prototype.enqueue = enqueue; gate.resolve(); await transport.dispose(); }
});
