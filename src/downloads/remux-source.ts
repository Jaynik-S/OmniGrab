import { BufferSource, CustomPathedSource, HLS_FORMATS, Input, UrlSource } from 'mediabunny';
import type { SourceRef } from 'mediabunny';
import type { DownloadPlan, ResourceFetch } from './model.ts';
import { parseDownloadHls } from './hls-plan.ts';
import { RemuxReadCache } from './remux-read-cache.ts';
import type { ReadMetrics, ReadOptions } from './remux-read-cache.ts';

/** Mediabunny source ownership; child-source caches and retries stay disabled. */
export class RemuxSourceAdapter {
  private readonly plan: DownloadPlan;
  private readonly signal: AbortSignal;
  private readonly inputs = new Set<Input>();
  private readonly sources = new Map<string, UrlSource>();
  private readonly refs: SourceRef[] = [];
  private readonly reads: RemuxReadCache;
  readonly metrics: Readonly<ReadMetrics>;
  private backgroundError: unknown;
  private disposed = false;
  private segmentGate?: (url: string) => Promise<void>;
  private readonly segmentUrls = new Set<string>();
  constructor(plan: DownloadPlan, fetcher: ResourceFetch,
    signal: AbortSignal, onBytes: (bytes: number) => void, options: ReadOptions = {}) {
    this.plan = plan; this.signal = signal;
    this.reads = new RemuxReadCache(plan, fetcher, signal, onBytes, options);
    this.metrics = this.reads.metrics;
    signal.addEventListener('abort', this.dispose, { once: true });
    if (signal.aborted) this.dispose();
  }

  check(): void {
    this.reads.check();
    if (this.backgroundError) throw this.backgroundError;
  }

  readonly fetch: ResourceFetch = async (input, init) => { this.check(); return this.reads.fetch(input, init); };
  settled(): Promise<void> { return this.reads.settled(); }

  setSegmentGate(gate: (url: string) => Promise<void>): void {
    this.check();
    for (const url of new Set([this.plan.selection.videoUrl, this.plan.selection.audioUrl])) {
      const manifest = this.plan.manifests.find(entry => entry.url === url);
      if (!manifest) continue;
      const parsed = parseDownloadHls(manifest.text, manifest.url, manifest.url);
      for (const line of parsed.text.split('\n')) if (line && !line.startsWith('#')) this.segmentUrls.add(line);
    }
    this.segmentGate = gate;
  }

  open(url: string, probeText?: string): Input {
    this.check();
    if (!this.plan.manifests.some(manifest => manifest.url === url)) throw new Error('Selected playlist is missing');
    const source = new CustomPathedSource(url, async request => {
      if (request.isRoot && probeText !== undefined) return new BufferSource(new TextEncoder().encode(probeText));
      const manifest = this.plan.manifests.find(entry => entry.url === request.path);
      if (manifest) return new BufferSource(new TextEncoder().encode(manifest.text));
      if (!this.plan.resources.some(resource => resource.url === request.path)) throw new Error('Media resource is outside the download plan');
      // Probe Inputs bypass only their own gate, including while another Input awaits validation.
      if (probeText === undefined && this.segmentUrls.has(request.path)) await this.segmentGate?.(request.path);
      this.check();
      let child = this.sources.get(request.path);
      if (!child) {
        // Positive limits are soft in Mediabunny 1.62.1; our shared read cache owns the hard bound.
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
    this.reads.dispose();
    this.signal.removeEventListener('abort', this.dispose);
    for (const input of this.inputs) input.dispose();
    for (const ref of this.refs) ref.free();
    this.inputs.clear(); this.refs.length = 0; this.sources.clear();
    this.segmentUrls.clear(); this.segmentGate = undefined;
  };
}
