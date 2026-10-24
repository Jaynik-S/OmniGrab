import { parseDownloadHls } from './hls-plan.ts';
import type { DownloadPlan, ResourceFetch, ResourceGrant } from './model.ts';

const CACHE_LIMIT = 32 * 1024 * 1024;
const MAX_READ = 64 * 1024 * 1024;
export interface ReadOptions { readWindowBytes?: number; prefetch?: boolean; }
export interface ReadMetrics {
  cachedBytes: number; maximumCachedBytes: number; inFlightBytes: number; maximumInFlightBytes: number;
  active: number; maximumActive: number; speculative: number; maximumSpeculative: number; requests: number; cacheHits: number;
}
interface Block {
  url: string; start: number; end: number; total: number; data: Uint8Array<ArrayBuffer>;
  headers: Headers; finalUrl: string; redirected: boolean;
}
interface Read {
  key: string; grant: ResourceGrant; start: number; end: number; init?: RequestInit;
  controller: AbortController; speculative: boolean; active: boolean; consumers: number;
  promise: Promise<Block>; resolve: (block: Block) => void; reject: (error: unknown) => void;
}

/** Owns every pending read, staging buffer and retained allocation for one remux. */
export class RemuxReadCache {
  private readonly plan: DownloadPlan;
  private readonly fetcher: ResourceFetch;
  private readonly signal: AbortSignal;
  private readonly onBytes: (bytes: number) => void;
  readonly metrics: ReadMetrics = { cachedBytes: 0, maximumCachedBytes: 0, inFlightBytes: 0, maximumInFlightBytes: 0,
    active: 0, maximumActive: 0, speculative: 0, maximumSpeculative: 0, requests: 0, cacheHits: 0 };
  private readonly cache = new Set<Block>();
  private readonly pending = new Map<string, Read>();
  private readonly operations = new Set<Promise<Block>>();
  private readonly queue: Read[] = [];
  private readonly totals = new Map<string, number>();
  private readonly completeObjects = new Set<string>();
  private readonly ignoredOrigins = new Set<string>();
  private readonly lanes: ResourceGrant[][] = [];
  private readonly lifetime = new AbortController();
  private readonly allocationWaiters: Array<() => void> = [];
  private allocatingWhole = false;
  private disposed = false;
  private error: unknown;
  private readonly window: number;
  private readonly prefetch: boolean;

  constructor(plan: DownloadPlan, fetcher: ResourceFetch,
    signal: AbortSignal, onBytes: (bytes: number) => void, options: ReadOptions = {}) {
    this.plan = plan; this.fetcher = fetcher; this.signal = signal; this.onBytes = onBytes;
    this.window = options.readWindowBytes ?? 4 * 1024 * 1024; this.prefetch = options.prefetch ?? true;
    if (!Number.isSafeInteger(this.window) || this.window < 1 || this.window > CACHE_LIMIT) throw new Error('Invalid media read window');
    for (const url of new Set([plan.selection.videoUrl, plan.selection.audioUrl])) {
      const manifest = plan.manifests.find(entry => entry.url === url);
      if (!manifest) continue;
      // Only actual selected media playlists define speculative order. Extra grants confer no intent.
      const selected = parseDownloadHls(manifest.text, manifest.url, manifest.url).resources;
      this.lanes.push(selected.filter(grant => plan.resources.some(allowed => allowed.url === grant.url &&
        (!allowed.range || !!grant.range && grant.range.start >= allowed.range.start && grant.range.end <= allowed.range.end))));
    }
    signal.addEventListener('abort', this.dispose, { once: true });
    if (signal.aborted) this.dispose();
  }

  check(): void {
    this.signal.throwIfAborted();
    if (this.error) throw this.error;
    if (this.disposed) throw new Error('Remux sources are closed');
  }
  private find(url: string, start: number): Block | undefined {
    for (const block of this.cache) if (block.url === url && block.start <= start && block.end >= start) {
      this.cache.delete(block); this.cache.add(block); return block;
    }
  }
  private retain(block: Block) {
    if (this.cache.delete(block)) this.metrics.cachedBytes -= block.data.buffer.byteLength;
    this.makeRoom(block.data.buffer.byteLength);
    this.cache.add(block); this.metrics.cachedBytes += block.data.buffer.byteLength;
    this.metrics.maximumCachedBytes = Math.max(this.metrics.maximumCachedBytes, this.metrics.cachedBytes);
  }
  private makeRoom(bytes: number) {
    while (this.metrics.cachedBytes + bytes > CACHE_LIMIT) {
      const oldest = this.cache.values().next().value!;
      this.cache.delete(oldest); this.metrics.cachedBytes -= oldest.data.buffer.byteLength;
    }
  }
  private response(block: Block, start: number, end: number): Response {
    const last = Math.min(end, block.end), headers = new Headers(block.headers);
    headers.set('Content-Range', `bytes ${start}-${last}/${block.total}`); headers.set('Content-Length', String(last - start + 1));
    const response = new Response(block.data.subarray(start - block.start, last - block.start + 1), { status: 206, headers });
    Object.defineProperties(response, { url: { value: block.finalUrl }, redirected: { value: block.redirected } });
    return response;
  }
  private bounds(grant: ResourceGrant, start: number) {
    const first = Math.max(grant.range?.start ?? 0, Math.floor(start / this.window) * this.window);
    return { start: first, end: Math.min(first + this.window - 1, grant.range?.end ?? Infinity, (this.totals.get(grant.url) ?? Infinity) - 1) };
  }
  private key(grant: ResourceGrant, start: number) { return JSON.stringify([grant.url, grant.range?.start, grant.range?.end, start]); }

  readonly fetch: ResourceFetch = async (input, init) => {
    this.check();
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    callerSignal?.throwIfAborted();
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const match = /^bytes=(\d+)-(\d*)$/.exec(headers.get('Range') ?? '');
    if (!match) throw new Error('Invalid media request range');
    const start = Number(match[1]), end = match[2] ? Number(match[2]) : start + MAX_READ - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) throw new Error('Invalid media request range');
    const grant = this.plan.resources.find(g => g.url === url && (!g.range || start >= g.range.start && start <= g.range.end));
    if (!grant) throw new Error('Media resource is outside the download plan');
    const requestedEnd = Math.min(end, grant.range?.end ?? Infinity);
    const cached = this.find(url, start);
    if (cached) {
      this.metrics.cacheHits++; this.lookAhead(grant, start);
      return this.response(cached, start, requestedEnd);
    }
    const bounds = this.bounds(grant, start);
    if (bounds.end < start) throw new Error('Media range is outside the object');
    const read = this.own(grant, bounds.start, false, { ...init, headers });
    if (read.speculative) { read.speculative = false; if (read.active) this.metrics.speculative--; this.pump(); }
    read.consumers++;
    try {
      const block = await this.wait(read.promise, callerSignal);
      this.check(); callerSignal?.throwIfAborted(); this.lookAhead(grant, start);
      return this.response(block, start, requestedEnd);
    } finally {
      read.consumers--;
      if (!read.consumers && !read.speculative && this.pending.has(read.key)) {
        read.controller.abort();
        if (!read.active) {
          this.queue.splice(this.queue.indexOf(read), 1); this.pending.delete(read.key); read.reject(read.controller.signal.reason);
        }
      }
    }
  };

  private own(grant: ResourceGrant, start: number, speculative: boolean, init?: RequestInit): Read {
    const bounds = this.bounds(grant, start), key = this.key(grant, bounds.start);
    const existing = this.pending.get(key); if (existing) return existing;
    let resolve!: Read['resolve'], reject!: Read['reject'];
    const promise = new Promise<Block>((yes, no) => { resolve = yes; reject = no; });
    const read: Read = { key, grant, ...bounds, init, controller: new AbortController(), speculative, active: false, consumers: 0, promise, resolve, reject };
    // Ownership and rejection handlers exist before any physical operation can launch.
    this.pending.set(key, read); this.operations.add(promise); this.queue.push(read);
    void promise.then(() => this.operations.delete(promise), error => {
      this.operations.delete(promise);
      if (read.speculative && !read.controller.signal.aborted && !this.disposed && !this.error) {
        this.error = error; this.lifetime.abort(error); this.stopQueued(error);
      }
    });
    this.pump(); return read;
  }
  private pump() {
    while (!this.disposed && !this.error && this.metrics.active < 4) {
      let index = this.queue.findIndex(read => !read.speculative);
      if (index < 0 && this.metrics.speculative < 3) index = this.queue.findIndex(read => read.speculative);
      if (index < 0) return;
      const read = this.queue.splice(index, 1)[0];
      if (read.speculative && this.ignoredOrigins.has(new URL(read.grant.url).origin)) {
        this.pending.delete(read.key); read.controller.abort(); read.reject(read.controller.signal.reason); continue;
      }
      read.active = true;
      this.metrics.active++; this.metrics.maximumActive = Math.max(this.metrics.maximumActive, this.metrics.active);
      if (read.speculative) { this.metrics.speculative++; this.metrics.maximumSpeculative = Math.max(this.metrics.maximumSpeculative, this.metrics.speculative); }
      void this.load(read).then(read.resolve, read.reject);
    }
  }
  private lookAhead(grant: ResourceGrant, start: number) {
    if (!this.prefetch || this.disposed || this.error || this.ignoredOrigins.has(new URL(grant.url).origin)) return;
    const lane = this.lanes.find(entries => entries.some(entry => entry.url === grant.url &&
      (!entry.range || start >= entry.range.start && start <= entry.range.end)));
    if (!lane) return;
    const index = lane.findIndex(entry => entry.url === grant.url && (!entry.range || start >= entry.range.start && start <= entry.range.end));
    let speculative = [...this.pending.values()].filter(read => read.speculative).length, candidates = 0;
    for (let n = index; n < lane.length && speculative < 3 && candidates < 3; n++) {
      const next = lane[n]; if (this.ignoredOrigins.has(new URL(next.url).origin)) continue;
      const end = Math.min(next.range?.end ?? Infinity, (this.totals.get(next.url) ?? Infinity) - 1);
      // An unknown object's first window is useful; never guess a window beyond unknown EOF.
      let cursor = n === index ? this.bounds(next, start).end + 1 : next.range?.start ?? 0;
      if (n === index && !Number.isFinite(end)) continue;
      while (cursor <= end && speculative < 3 && candidates < 3) {
        candidates++;
        const bounds = this.bounds(next, cursor);
        if (!this.find(next.url, cursor) && !this.pending.has(this.key(next, bounds.start))) {
          this.own(next, cursor, true); speculative++;
        }
        if (!Number.isFinite(end)) break;
        cursor = bounds.end + 1;
      }
    }
  }
  private async wait<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
    if (!signal) return promise;
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      void promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
      if (signal.aborted) abort();
    });
  }
  private async wholeAllocation(signal: AbortSignal): Promise<() => void> {
    while (this.allocatingWhole) {
      let wake!: () => void;
      const ready = new Promise<void>(resolve => { wake = resolve; this.allocationWaiters.push(wake); });
      try { await this.wait(ready, signal); }
      finally { const index = this.allocationWaiters.indexOf(wake); if (index >= 0) this.allocationWaiters.splice(index, 1); }
    }
    signal.throwIfAborted(); this.allocatingWhole = true;
    return () => {
      this.allocatingWhole = false;
      // Wake every bounded contender so an aborted waiter cannot consume the only handoff.
      for (const wake of this.allocationWaiters.splice(0)) wake();
    };
  }
  private async load(read: Read): Promise<Block> {
    const signal = AbortSignal.any([this.signal, this.lifetime.signal, read.controller.signal]);
    let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cancellation: Promise<void> | undefined;
    let allocated = 0, releaseAllocation: (() => void) | undefined;
    try {
      signal.throwIfAborted();
      const requestStart = this.completeObjects.has(read.grant.url) ? 0 : read.start;
      const requestEnd = requestStart !== read.start ? this.window - 1 : this.bounds(read.grant, read.start).end;
      const headers = new Headers(read.init?.headers); headers.set('Range', `bytes=${requestStart}-${requestEnd}`);
      this.metrics.requests++;
      const fetcher = this.fetcher; // Native fetch cannot receive the cache as its receiver.
      response = await fetcher(read.grant.url, { ...read.init, headers, signal });
      signal.throwIfAborted(); this.check();
      if (!response.ok || !response.body) throw new Error('Media response failed');
      if (response.headers.has('Content-Encoding')) throw new Error('Encoded media range is unsupported');
      let first = 0, last: number, total: number;
      if (response.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '');
        if (!range) throw new Error('Invalid media response range');
        first = Number(range[1]); last = Number(range[2]); total = Number(range[3]);
        if (![first, last, total].every(Number.isSafeInteger) || first !== requestStart || last < read.start || total <= last ||
          last !== Math.min(requestEnd, total - 1)) throw new Error('Invalid media response range');
      } else {
        const length = response.headers.get('Content-Length'); total = Number(length); last = total - 1;
        if (response.status !== 200 || read.grant.range || requestStart !== 0 || !length || !/^\d+$/.test(length) ||
          !Number.isSafeInteger(total) || total <= read.start || total > MAX_READ) throw new Error('Media response ignored range');
        this.completeObjects.add(read.grant.url); this.ignoredOrigins.add(new URL(read.grant.url).origin);
      }
      const expected = last - first + 1, length = response.headers.get('Content-Length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) !== expected)) throw new Error('Invalid media response length');
      this.totals.set(read.grant.url, total);
      if (!read.speculative) this.lookAhead(read.grant, read.start);
      // Headers may arrive concurrently for unknown origins. Hold their physical leases,
      // but pull no body and allocate nothing until this separate complete-body gate opens.
      if (response.status === 200) releaseAllocation = await this.wholeAllocation(signal);
      signal.throwIfAborted();
      const data = new Uint8Array(expected); allocated = data.buffer.byteLength;
      this.metrics.inFlightBytes += allocated; this.metrics.maximumInFlightBytes = Math.max(this.metrics.maximumInFlightBytes, this.metrics.inFlightBytes);
      reader = response.body.getReader();
      const cancel = () => { cancellation ??= reader!.cancel(signal.reason).catch(() => {}); };
      signal.addEventListener('abort', cancel, { once: true });
      let received = 0;
      try {
        while (true) {
          signal.throwIfAborted(); const chunk = await reader.read(); signal.throwIfAborted();
          if (chunk.done) break;
          this.onBytes(chunk.value.byteLength);
          if (received + chunk.value.byteLength > expected) throw new Error('Media read limit exceeded');
          data.set(chunk.value, received); received += chunk.value.byteLength;
        }
      } finally { signal.removeEventListener('abort', cancel); }
      if (received !== expected) throw new Error('Truncated media response');
      this.check(); signal.throwIfAborted(); reader.releaseLock(); reader = undefined;
      let selected: Block | undefined;
      const block = (bytes: Uint8Array<ArrayBuffer>, offset: number): Block => ({ url: read.grant.url, start: first + offset,
        end: first + offset + bytes.length - 1, total, data: bytes, headers: new Headers(response!.headers), finalUrl: response!.url, redirected: response!.redirected });
      if (expected <= this.window) {
        selected = block(data, 0); this.metrics.inFlightBytes -= allocated; allocated = 0; this.retain(selected);
      } else {
        // Complete objects can exceed cache capacity. Independent blocks prevent a small
        // cached view from retaining an unaccounted 64 MiB backing buffer.
        const selectedOffset = Math.floor((read.start - first) / this.window) * this.window;
        const copy = (offset: number) => {
          const end = Math.min(offset + this.window, data.length);
          this.makeRoom(end - offset); // Evict before allocating another retained block.
          const entry = block(data.slice(offset, end), offset); this.retain(entry); return entry;
        };
        for (let offset = 0; offset < data.length; offset += this.window) {
          if (offset !== selectedOffset) copy(offset);
        }
        selected = copy(selectedOffset);
      }
      if (!selected) throw new Error('Media response does not cover requested range');
      return selected;
    } catch (error) {
      if (!read.controller.signal.aborted && !this.disposed && !this.error) {
        this.error = error; this.lifetime.abort(error); this.stopQueued(error);
      }
      if (reader) { cancellation ??= reader.cancel().catch(() => {}); await cancellation; reader.releaseLock(); }
      else if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
      throw error;
    } finally {
      this.metrics.inFlightBytes -= allocated; releaseAllocation?.();
      this.metrics.active--; if (read.speculative) this.metrics.speculative--;
      this.pending.delete(read.key); this.pump();
    }
  }
  private stopQueued(error: unknown) {
    for (const read of this.queue.splice(0)) { this.pending.delete(read.key); read.reject(error); }
  }
  readonly dispose = () => {
    if (this.disposed) return;
    this.disposed = true; this.lifetime.abort(); this.signal.removeEventListener('abort', this.dispose);
    this.stopQueued(this.lifetime.signal.reason); this.cache.clear(); this.totals.clear(); this.completeObjects.clear(); this.ignoredOrigins.clear(); this.lanes.length = 0;
    this.metrics.cachedBytes = 0;
  };
  async settled(): Promise<void> { while (this.operations.size) await Promise.allSettled([...this.operations]); }
}
