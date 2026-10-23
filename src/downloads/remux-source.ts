import { BufferSource, CustomPathedSource, HLS_FORMATS, Input, UrlSource } from 'mediabunny';
import type { SourceRef } from 'mediabunny';
import type { DownloadPlan, ResourceFetch } from './model.ts';

const BLOCK = 256 * 1024;
const CACHE_LIMIT = 32 * 1024 * 1024;
const MAX_READ = 64 * 1024 * 1024;
interface Block {
  url: string; start: number; end: number; total: number; data: Uint8Array<ArrayBuffer>;
  headers: Headers; finalUrl: string; redirected: boolean;
}

/** Shared hard byte cache; library child-source caches and retries are disabled. */
export class RemuxSourceAdapter {
  private readonly plan: DownloadPlan;
  private readonly fetcher: ResourceFetch;
  private readonly signal: AbortSignal;
  private readonly onBytes: (bytes: number) => void;
  private readonly cache = new Set<Block>();
  private cachedBytes = 0;
  private readonly inputs = new Set<Input>();
  private readonly completeObjects = new Set<string>();
  private readonly sources = new Map<string, UrlSource>();
  private readonly refs: SourceRef[] = [];
  private backgroundError: unknown;
  private disposed = false;
  private readonly lifetime = new AbortController();
  constructor(plan: DownloadPlan, fetcher: ResourceFetch, signal: AbortSignal, onBytes: (bytes: number) => void) {
    this.plan = plan; this.fetcher = fetcher; this.signal = signal; this.onBytes = onBytes;
    signal.addEventListener('abort', this.dispose, { once: true });
  }

  check(): void {
    this.signal.throwIfAborted();
    if (this.backgroundError) throw this.backgroundError;
    if (this.disposed) throw new Error('Remux sources are closed');
  }

  private response(block: Block, start: number, end: number): Response {
    const last = Math.min(end, block.end);
    const headers = new Headers(block.headers);
    headers.set('Content-Range', `bytes ${start}-${last}/${block.total}`);
    headers.set('Content-Length', String(last - start + 1));
    const response = new Response(block.data.subarray(start - block.start, last - block.start + 1), { status: 206, headers });
    Object.defineProperties(response, { url: { value: block.finalUrl }, redirected: { value: block.redirected } });
    return response;
  }

  readonly fetch: ResourceFetch = async (input, init) => {
    this.check();
    init?.signal?.throwIfAborted();
    const url = input instanceof Request ? input.url : String(input);
    const grants = this.plan.resources.filter(resource => resource.url === url);
    if (!grants.length) throw new Error('Media resource is outside the download plan');
    const headers = new Headers(init?.headers);
    const range = /^bytes=(\d+)-(\d*)$/.exec(headers.get('Range') ?? '');
    if (!range) throw new Error('Invalid media request range');
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : start + MAX_READ - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start)
      throw new Error('Invalid media request range');
    const grant = grants.find(g => !g.range || start >= g.range.start && start <= g.range.end);
    if (!grant) throw new Error('Media range is outside the download plan');
    const requestedEnd = Math.min(end, grant.range?.end ?? Infinity);
    for (const block of this.cache) {
      if (block.url === url && block.start <= start && block.end >= start) {
        this.cache.delete(block); this.cache.add(block);
        return this.response(block, start, requestedEnd);
      }
    }
    // Alignment improves reuse. Never widen beyond a MAP/segment's actual grant.
    const blockStart = Math.max(grant.range?.start ?? 0, Math.floor(start / BLOCK) * BLOCK);
    const blockEnd = Math.min(blockStart + BLOCK - 1, grant.range?.end ?? Infinity);
    const requestStart = this.completeObjects.has(url) ? 0 : blockStart;
    const requestEnd = requestStart === 0 && blockStart !== 0 ? BLOCK - 1 : blockEnd;
    headers.set('Range', `bytes=${requestStart}-${requestEnd}`);
    const fetcher = this.fetcher; // Native fetch must not receive this adapter as its receiver.
    const requestSignal = AbortSignal.any([this.signal, this.lifetime.signal, ...(init?.signal ? [init.signal] : [])]);
    const response = await fetcher(input, { ...init, headers, signal: requestSignal });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      this.check();
      if (!response.ok || !response.body) throw new Error('Media response failed');
      if (response.headers.has('Content-Encoding')) throw new Error('Encoded media range is unsupported');
      let first = 0; let last: number; let total: number;
      if (response.status === 206) {
        const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '');
        if (!contentRange) throw new Error('Invalid media response range');
        first = Number(contentRange[1]); last = Number(contentRange[2]); total = Number(contentRange[3]);
        if (![first, last, total].every(Number.isSafeInteger) || first !== requestStart || last < Math.max(first, start) || last > requestEnd || total <= last)
          throw new Error('Invalid media response range');
      } else {
        // A transport may provide a complete bounded object when its origin ignores ranges.
        const length = response.headers.get('Content-Length');
        total = Number(length); last = total - 1;
        if (response.status !== 200 || grant.range || requestStart !== 0 || !length || !/^\d+$/.test(length) ||
          !Number.isSafeInteger(total) || total <= 0 || total > MAX_READ) throw new Error('Media response ignored range');
        this.completeObjects.add(url);
      }
      const expected = last - first + 1;
      const length = response.headers.get('Content-Length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) !== expected)) throw new Error('Invalid media response length');
      // Only one bounded block per ranged request; complete-object fallback is capped at 64 MiB.
      const data = new Uint8Array(expected);
      reader = response.body.getReader();
      let received = 0;
      while (true) {
        this.check(); requestSignal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        this.onBytes(chunk.value.byteLength);
        if (received + chunk.value.byteLength > expected) throw new Error('Media read limit exceeded');
        data.set(chunk.value, received); received += chunk.value.byteLength;
      }
      if (received !== expected) throw new Error('Truncated media response');
      this.check();
      reader.releaseLock(); reader = undefined;
      // Keep each cached ArrayBuffer <=256 KiB; both the hard total and LRU eviction
      // count actual owned bytes. Split a bounded full-object fallback into blocks.
      let selected: Block | undefined;
      for (let offset = 0; offset < data.length; offset += BLOCK) {
        const bytes = data.slice(offset, Math.min(offset + BLOCK, data.length));
        const block: Block = { url, start: first + offset, end: first + offset + bytes.length - 1, total,
          data: bytes, headers: new Headers(response.headers), finalUrl: response.url, redirected: response.redirected };
        while (this.cachedBytes + bytes.length > CACHE_LIMIT) {
          const oldest = this.cache.values().next().value!;
          this.cache.delete(oldest); this.cachedBytes -= oldest.data.byteLength;
        }
        this.cache.add(block); this.cachedBytes += bytes.length;
        if (block.start <= start && block.end >= start) selected = block;
      }
      if (!selected) throw new Error('Media response does not cover requested range');
      // A complete >32 MiB object may evict its requested early block while being
      // split. The block actually returned is the most recently used, not the last split.
      if (this.cache.delete(selected)) this.cachedBytes -= selected.data.byteLength;
      while (this.cachedBytes + selected.data.byteLength > CACHE_LIMIT) {
        const oldest = this.cache.values().next().value!;
        this.cache.delete(oldest); this.cachedBytes -= oldest.data.byteLength;
      }
      this.cache.add(selected); this.cachedBytes += selected.data.byteLength;
      return this.response(selected, start, requestedEnd);
    } catch (error) {
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      else if (!response.body?.locked) await response.body?.cancel().catch(() => {});
      throw error;
    }
  };

  open(url: string, probeText?: string): Input {
    this.check();
    if (!this.plan.manifests.some(manifest => manifest.url === url)) throw new Error('Selected playlist is missing');
    const source = new CustomPathedSource(url, request => {
      if (request.isRoot && probeText !== undefined) return new BufferSource(new TextEncoder().encode(probeText));
      const manifest = this.plan.manifests.find(entry => entry.url === request.path);
      if (manifest) return new BufferSource(new TextEncoder().encode(manifest.text));
      if (!this.plan.resources.some(resource => resource.url === request.path)) throw new Error('Media resource is outside the download plan');
      let child = this.sources.get(request.path);
      if (!child) {
        // Positive limits are soft in Mediabunny 1.62.1; our shared cache above owns the hard bound.
        child = new UrlSource(request.path, { fetchFn: this.fetch, maxCacheSize: 0, parallelism: 1,
          getRetryDelay: () => null, handleUnhandledError: error => { this.backgroundError ??= error; } });
        this.refs.push(child.ref()); this.sources.set(request.path, child);
      }
      return child;
    });
    const input = new Input({ source, formats: HLS_FORMATS }); this.inputs.add(input); return input;
  }

  release(input: Input): void { input.dispose(); this.inputs.delete(input); }

  readonly dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort();
    this.signal.removeEventListener('abort', this.dispose);
    for (const input of this.inputs) input.dispose();
    for (const ref of this.refs) ref.free();
    this.inputs.clear(); this.refs.length = 0; this.sources.clear(); this.cache.clear(); this.completeObjects.clear(); this.cachedBytes = 0;
  };
}
