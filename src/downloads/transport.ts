import { BINARY_PORT, BinaryGrants, MAX_BODY_BYTES, decodeChunk, produceBinary, safeUrl, validId, validRange, validateResponse } from './binary-protocol.ts';
import type { BinaryMessage, BinaryRequest, ProducerControl } from './binary-protocol.ts';
import type { DownloadSelection, ResourceFetch, ResourceGrant, ByteRange } from './model.ts';

export interface TransportMetrics {
  active: number; maximumActive: number; queuedBytes: number; maximumQueuedBytes: number;
  maximumUnacknowledgedPerRequest: number; attempts: number; receivedBytes: number; quarantined: number;
}
export interface DownloadAttachment { type: 'download-attach'; jobId: string; capability: string; selection: DownloadSelection; expiresAt: number; }
interface Transaction { message(value: unknown): void; disconnected(): void; }

/** Instantiate once in the one-job host. No tab APIs or binary service-worker relay. */
export function createDownloadTransport(options: { jobId: string; selection: DownloadSelection; fetcher?: typeof fetch; runtimeId?: string; validateDocument: () => Promise<boolean>; idleMs?: number; requestMs?: number }) {
  if (!validId(options.jobId)) throw new Error('download-job-invalid');
  const idleMs = Math.min(15_000, options.idleMs ?? 15_000), requestMs = Math.min(120_000, options.requestMs ?? 120_000);
  if (![idleMs, requestMs].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('download-deadline-invalid');
  const grants = new BinaryGrants(), unrestricted = new BinaryGrants();
  const initial = [options.selection.sourceUrl, options.selection.videoUrl, options.selection.audioUrl].filter((u): u is string => !!u).map(url => ({ url }));
  grants.add(initial); unrestricted.add(initial);
  const allGrants = [...initial] as ResourceGrant[];
  const metrics: TransportMetrics = { active: 0, maximumActive: 0, queuedBytes: 0, maximumQueuedBytes: 0, maximumUnacknowledgedPerRequest: 0, attempts: 0, receivedBytes: 0, quarantined: 0 };
  const lifetime = new AbortController();
  const transactions = new Map<string, Transaction>(), operations = new Set<Promise<void>>();
  const waiters: Array<() => void> = [];
  let port: chrome.runtime.Port | undefined, ready = false, poisoned = false, counter = 0;
  let pending: DownloadAttachment | undefined, attachmentCapability: string | undefined;
  const quarantinedReleases: Array<() => void> = [];
  const manifestUrls = new Set(initial.map(g => g.url));
  let readyResolve: (() => void) | undefined;
  const changeQueued = (delta: number) => {
    metrics.queuedBytes += delta; metrics.maximumQueuedBytes = Math.max(metrics.maximumQueuedBytes, metrics.queuedBytes);
    if (metrics.queuedBytes > 8 * 1024 * 1024) { poisoned = true; lifetime.abort(new Error('download-queue-limit')); }
  };
  const wake = () => { while (waiters.length && metrics.active < 4) waiters.shift()!(); };
  const checkDocument = async () => { if (poisoned) throw new Error('download-port-disconnected'); lifetime.signal.throwIfAborted(); if (!await options.validateDocument()) throw new Error('download-stale-document'); lifetime.signal.throwIfAborted(); };
  async function acquire(signal: AbortSignal) {
    signal.throwIfAborted();
    while (metrics.active >= 4) {
      if (waiters.length >= 200) throw new Error('download-request-queue-limit');
      await new Promise<void>((resolve, reject) => {
        const resume = () => { signal.removeEventListener('abort', abort); resolve(); };
        const abort = () => { const i = waiters.indexOf(resume); if (i >= 0) waiters.splice(i, 1); reject(signal.reason); };
        waiters.push(resume); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      });
      signal.throwIfAborted();
    }
    metrics.active++; metrics.maximumActive = Math.max(metrics.maximumActive, metrics.active);
    let released = false; return () => { if (released) return; released = true; metrics.active--; wake(); };
  }
  function update(granted: ResourceGrant[]) {
    lifetime.signal.throwIfAborted(); if (poisoned) throw new Error('download-port-disconnected');
    grants.add(granted); unrestricted.add(granted.filter(g => !g.range)); allGrants.push(...granted);
    if (port) port.postMessage({ type: 'grants', jobId: options.jobId, grants: granted });
  }
  function attempt(url: string, range: ByteRange | undefined, maxBytes: number, page: boolean, signal: AbortSignal, expiresAt: number): { response: Promise<Response>; done: Promise<void>; uncertain: () => boolean } {
    const request: BinaryRequest = { type: 'request', jobId: options.jobId, requestId: `r${++counter}`, url, ...(range ? { range } : {}), maxBytes, idleMs, expiresAt };
    metrics.attempts++;
    let resolveResponse!: (response: Response) => void, rejectResponse!: (error: unknown) => void, resolveDone!: () => void;
    const response = new Promise<Response>((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
    const done = new Promise<void>(resolve => { resolveDone = resolve; });
    let body: ReadableStreamDefaultController<Uint8Array> | undefined, producer: ProducerControl | undefined;
    let sequence = 0, offset = 0, headersSeen = false, finished = false, disconnected = false;
    let held: { bytes: Uint8Array; message: Extract<BinaryMessage, { type: 'chunk' }>; weight: number } | undefined;
    let demand = false, settleTimer: ReturnType<typeof setTimeout> | undefined;
    const reservation = page ? 1024 * 1024 : 0; if (reservation) changeQueued(reservation);
    const send = (message: BinaryMessage) => {
      if (page) { try { port?.postMessage(message); } catch { transactions.get(request.requestId)?.disconnected(); } }
      else if (message.type === 'ack') producer?.ack(message.sequence, message.offset);
      else if (message.type === 'abort') producer?.abort();
    };
    const discard = () => { if (held) { changeQueued(-held.weight); held = undefined; } };
    const cleanup = () => {
      if (finished) return; finished = true; discard(); if (reservation) changeQueued(-reservation);
      clearTimeout(settleTimer); signal.removeEventListener('abort', abort); transactions.delete(request.requestId); resolveDone();
    };
    const errorBody = (error: unknown) => { rejectResponse(error); try { body?.error(error); } catch { /* Consumer canceled. */ } };
    const abort = () => { errorBody(signal.reason ?? new Error('download-aborted')); discard(); send({ type: 'abort', jobId: request.jobId, requestId: request.requestId }); };
    const consume = () => {
      if (!held || !demand || signal.aborted) return;
      const item = held; held = undefined; offset += item.bytes.length; sequence++; demand = false;
      // Native fast consumers can pull again inside enqueue; this chunk is already claimed.
      try { body!.enqueue(item.bytes); }
      catch (error) { errorBody(error); send({ type: 'abort', jobId: request.jobId, requestId: request.requestId }); return; }
      finally { changeQueued(-item.weight); }
      send({ type: 'ack', jobId: request.jobId, requestId: request.requestId, sequence: item.message.sequence, offset });
    };
    const transaction: Transaction = {
      disconnected() {
        if (finished) return; disconnected = true; poisoned = true; metrics.quarantined++;
        errorBody(new Error('download-port-disconnected')); cleanup();
      },
      message(value) {
        if (finished) return;
        try {
          const m = value as BinaryMessage;
          if (!m || m.jobId !== request.jobId || m.requestId !== request.requestId) throw new Error('download-message-binding-invalid');
          if (m.type === 'headers') {
            if (headersSeen || m.status !== 200 && m.status !== 206 || !Array.isArray(m.headers) || m.headers.length > 16 || JSON.stringify(m.headers).length > 32_768 || typeof m.redirected !== 'boolean') throw new Error('download-headers-invalid');
            const finalUrl = safeUrl(m.url); const headers = new Headers(m.headers);
            validateResponse(new Response(null, { status: m.status, headers }), request, !unrestricted.permits(url)); headersSeen = true;
            const stream = new ReadableStream<Uint8Array>({ start(c) { body = c; }, pull() { demand = true; consume(); }, cancel() { send({ type: 'abort', jobId: request.jobId, requestId: request.requestId }); discard(); } }, { highWaterMark: 0 });
            const result = new Response(stream, { status: m.status, headers });
            Object.defineProperties(result, { url: { value: finalUrl }, redirected: { value: m.redirected } }); resolveResponse(result);
          } else if (m.type === 'chunk') {
            if (!headersSeen || held || m.sequence !== sequence || m.offset !== offset) throw new Error('download-chunk-order-invalid');
            const bytes = decodeChunk(m); if (offset + bytes.length > maxBytes) throw new Error('download-body-limit');
            metrics.receivedBytes += bytes.length; metrics.maximumUnacknowledgedPerRequest = Math.max(1, metrics.maximumUnacknowledgedPerRequest);
            const weight = bytes.length + m.data.length * 2; held = { bytes, message: m, weight }; changeQueued(weight); consume();
          } else if (m.type === 'end') {
            if (!headersSeen || held || m.sequence !== sequence || m.offset !== offset) throw new Error('download-end-invalid');
            body!.close(); cleanup();
          } else if (m.type === 'error') {
            if (typeof m.error !== 'string' || m.error.length > 1000) throw new Error('download-error-invalid');
            errorBody(new Error(m.error)); cleanup();
          } else throw new Error('download-message-invalid');
        } catch (error) { errorBody(error); discard(); send({ type: 'abort', jobId: request.jobId, requestId: request.requestId }); }
      },
    };
    transactions.set(request.requestId, transaction); signal.addEventListener('abort', abort, { once: true });
    if (page) {
      // If the document becomes unreachable no replacement work is admitted. A deadline cannot prove settlement.
      settleTimer = setTimeout(() => transaction.disconnected(), Math.max(1, expiresAt - Date.now() + 1000));
      port!.postMessage(request);
    } else {
      producer = produceBinary(request, { grants, unrestricted: unrestricted.permits(url), fetcher: options.fetcher ?? fetch, send: value => queueMicrotask(() => transaction.message(value)), queued: changeQueued });
      void producer.settled.then(() => { if (!finished) cleanup(); });
    }
    if (signal.aborted) abort();
    return { response, done, uncertain: () => disconnected };
  }
  const fetchResource: ResourceFetch = async (input, init) => {
    const url = safeUrl(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const rangeHeader = headers.get('range'); let range: ByteRange | undefined;
    if (rangeHeader) { const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader); if (!match) throw new Error('download-range-invalid'); range = { start: Number(match[1]), end: Number(match[2]) }; if (!validRange(range)) throw new Error('download-range-invalid'); }
    if (init?.method && init.method !== 'GET' || input instanceof Request && input.method !== 'GET' || !grants.permits(url, range)) throw new Error('download-request-grant-invalid');
    await checkDocument();
    const signal = AbortSignal.any([lifetime.signal, ...(init?.signal ? [init.signal] : input instanceof Request ? [input.signal] : [])]);
    const expiresAt = Date.now() + requestMs; const deadline = AbortSignal.timeout(requestMs); const combined = AbortSignal.any([signal, deadline]);
    const release = await acquire(combined);
    let operationDone!: () => void; const tracked = new Promise<void>(resolve => { operationDone = resolve; }); operations.add(tracked);
    let retained = false, lastDone: Promise<void> | undefined;
    try {
      await checkDocument(); let page = false;
      for (let number = 0; number < 3; number++) {
        combined.throwIfAborted();
        if (page) {
          await checkDocument();
          if (!port || !ready) throw new Error('download-page-unavailable');
        }
        const attemptResult = attempt(url, range, manifestUrls.has(url) ? 2 * 1024 * 1024 : MAX_BODY_BYTES, page, combined, expiresAt); lastDone = attemptResult.done;
        try {
          const result = await attemptResult.response;
          retained = true; void attemptResult.done.then(() => { if (!attemptResult.uncertain()) release(); else quarantinedReleases.push(release); operationDone(); operations.delete(tracked); });
          return result;
        } catch (error) {
          await attemptResult.done;
          if (attemptResult.uncertain()) { retained = true; quarantinedReleases.push(release); throw error; }
          combined.throwIfAborted();
          const text = String(error instanceof Error ? error.message : error);
          const idleTimeout = text === 'download-timeout';
          if (!page && port && ready && (idleTimeout || /download-http:(?:401|403|404|410|5\d\d)/.test(text) || /fetch|network|Failed/i.test(text))) { page = true; continue; }
          if (!idleTimeout && !/download-http:(?:408|429|5\d\d)|fetch|network|Failed/i.test(text) || number === 2) throw error;
        }
      }
      throw new Error('download-attempt-limit');
    } finally {
      if (!retained) { if (lastDone) await lastDone; release(); }
      if (!retained || poisoned) { operationDone(); operations.delete(tracked); }
    }
  };
  return {
    fetch: fetchResource, metrics,
    grantManifests: (urls: string[]) => { const checked = urls.map(safeUrl); update(checked.map(url => ({ url }))); for (const url of checked) manifestUrls.add(url); }, grantResources: update,
    expectAttachment(capability: string): DownloadAttachment {
      if (!/^[a-zA-Z0-9_-]{32,128}$/.test(capability) || pending || port || poisoned || lifetime.signal.aborted) throw new Error('download-attachment-invalid');
      attachmentCapability = capability; pending = { type: 'download-attach', jobId: options.jobId, capability, selection: { ...options.selection }, expiresAt: Date.now() + 10_000 }; return pending;
    },
    async acceptPort(candidate: chrome.runtime.Port): Promise<boolean> {
      if (!candidate.name.startsWith(BINARY_PORT)) return false;
      let info: { jobId: string; capability: string };
      try { info = JSON.parse(candidate.name.slice(BINARY_PORT.length)); } catch { candidate.disconnect(); return false; }
      const expected = pending, sender = candidate.sender;
      if (!expected || expected.expiresAt <= Date.now() || expected.jobId !== info.jobId || expected.capability !== info.capability || sender?.id !== (options.runtimeId ?? chrome.runtime.id) || sender?.tab?.id !== options.selection.tabId || sender.frameId !== options.selection.frameId || sender.documentId !== options.selection.documentId || port || poisoned) return false;
      pending = undefined;
      if (!await options.validateDocument() || lifetime.signal.aborted || poisoned) { candidate.disconnect(); return false; }
      port = candidate;
      candidate.onMessage.addListener((value: unknown) => {
        const m = value as { type: string; jobId: string; requestId: string };
        if (m?.type === 'ready' && m.jobId === options.jobId) { ready = true; readyResolve?.(); return; }
        transactions.get(m?.requestId)?.message(value);
      });
      candidate.onDisconnect.addListener(() => { ready = false; poisoned = true; for (const transaction of [...transactions.values()]) transaction.disconnected(); lifetime.abort(new Error('download-port-disconnected')); });
      const readiness = new Promise<void>((resolve, reject) => { readyResolve = resolve; const timer = setTimeout(() => reject(new Error('download-attachment-timeout')), 5000); const done = () => clearTimeout(timer); readyResolve = () => { done(); resolve(); }; });
      candidate.postMessage({ type: 'grants', jobId: options.jobId, grants: allGrants });
      await readiness; return true;
    },
    async abort() { lifetime.abort(new Error('download-aborted')); await Promise.all([...operations]); },
    async dispose() { lifetime.abort(new Error('download-disposed')); await Promise.all([...operations]); port?.disconnect(); pending = undefined; },
    /** Trusted coordinator only: call after exact-document detach receipt or proved document teardown. */
    confirmAttachmentStopped(capability: string) {
      if (!attachmentCapability || attachmentCapability !== capability) throw new Error('download-attachment-invalid');
      for (const release of quarantinedReleases.splice(0)) release(); metrics.quarantined = 0;
    },
  };
}
