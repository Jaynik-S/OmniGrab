import type { MediaItem, ProbeJob, Snapshot } from '../core/model.ts';
import { applyManifest, probeFailed, probeStarted } from '../core/reducer.ts';
import { normalizeUrl } from '../core/identity.ts';
import { parseHls } from '../manifests/hls.ts';
import { parseDash } from '../manifests/dash.ts';
import type { DetectionStore } from './store.ts';

export interface ManifestProbeOptions {
  concurrency?: number;
  timeoutMs?: number;
  maxBytes?: number;
}

interface Completion {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function pending(item: MediaItem): boolean {
  return (item.type === 'hls' || item.type === 'dash') && (item.status === 'observed' || item.status === 'probing');
}
function current(snapshot: Snapshot, job: ProbeJob): boolean {
  const tab = snapshot.tabs[job.tabId];
  const item = tab?.media[job.itemId];
  return tab?.epoch === job.epoch && !!item && item.instance === job.instance && item.url === job.url && item.type === job.kind && pending(item);
}
const keyOf = (job: ProbeJob) => JSON.stringify([job.tabId, job.epoch, job.url, job.instance]);

function pendingJobs(snapshot: Snapshot): ProbeJob[] {
  return Object.values(snapshot.tabs).flatMap(tab => Object.values(tab.media).filter(pending).map(item => ({
    tabId: tab.id, epoch: tab.epoch, itemId: item.id, url: item.url, kind: item.type as 'hls' | 'dash', instance: item.instance,
  })));
}

async function readBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new Error('manifest-size-limit');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let bytes = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parts: string[] = [];
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('manifest-size-limit');
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join('');
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

/** Durable statuses are the pending queue; in-memory maps only coalesce callers and active work. */
export class ManifestProbe {
  private store: DetectionStore;
  private fetcher: typeof fetch;
  private concurrency: number;
  private timeoutMs: number;
  private maxBytes: number;
  private active = new Set<string>();
  private failed = new Set<string>();
  private completions = new Map<string, Completion>();
  private scheduling = Promise.resolve();

  constructor(store: DetectionStore, fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init), options: ManifestProbeOptions = {}) {
    this.store = store;
    this.fetcher = fetcher;
    this.concurrency = Math.min(4, options.concurrency ?? 4);
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    for (const value of [this.concurrency, this.timeoutMs, this.maxBytes]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid manifest probe limit');
    }
  }

  async enqueue(job: ProbeJob): Promise<void> {
    const key = keyOf(job);
    const existing = this.completions.get(key);
    if (existing) return existing.promise;
    if (!current(await this.store.read(), job)) return;
    const concurrent = this.completions.get(key);
    if (concurrent) return concurrent.promise;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    this.completions.set(key, { promise, resolve, reject });
    this.schedule();
    return promise;
  }

  async recover(): Promise<void> {
    const jobs = pendingJobs(await this.store.read());
    await Promise.all(jobs.map(job => this.enqueue(job)));
  }

  private schedule(): void {
    this.scheduling = this.scheduling.then(() => this.fill()).catch(error => {
      for (const [key, completion] of this.completions) {
        if (!this.active.has(key)) { completion.reject(error); this.completions.delete(key); }
      }
    });
  }

  private async fill(): Promise<void> {
    const jobs = pendingJobs(await this.store.read());
    const keys = new Set(jobs.map(keyOf));
    for (const key of this.failed) if (!keys.has(key) && !this.active.has(key)) this.failed.delete(key);
    for (const [key, completion] of this.completions) {
      if ((!keys.has(key) || this.failed.has(key)) && !this.active.has(key)) {
        completion.resolve(); this.completions.delete(key);
      }
    }
    for (const job of jobs) {
      if (this.active.size >= this.concurrency) break;
      const key = keyOf(job);
      if (this.active.has(key) || this.failed.has(key)) continue;
      this.active.add(key);
      void this.run(job).then(() => {
        this.completions.get(key)?.resolve();
      }, error => {
        // A storage failure leaves durable pending work for a future worker, without a retry loop here.
        this.failed.add(key);
        this.completions.get(key)?.reject(error);
      }).finally(() => {
        this.completions.delete(key);
        this.active.delete(key);
        this.schedule();
      });
    }
  }

  private async run(job: ProbeJob): Promise<void> {
    const saved = await this.store.dispatch(snapshot => current(snapshot, job) ? probeStarted(snapshot, job) : snapshot);
    if (!current(saved, job) || !current(await this.store.read(), job)) return;
    if (!normalizeUrl(job.url)) {
      await this.store.dispatch(snapshot => probeFailed(snapshot, job, 'manifest-url-invalid'));
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error('manifest-timeout');
        controller.abort(error);
        reject(error);
      }, this.timeoutMs);
    });
    let info;
    try {
      info = await Promise.race([deadline, (async () => {
        const response = await this.fetcher(job.url, { credentials: 'include', signal: controller.signal, redirect: 'follow' });
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          controller.signal.throwIfAborted();
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new Error(`manifest-http:${response.status}`);
        }
        const base = normalizeUrl(response.url || job.url);
        if (!base) throw new Error('manifest-response-url-invalid');
        const body = await readBody(response, this.maxBytes, controller.signal);
        return job.kind === 'hls' ? parseHls(body, base) : parseDash(body, base);
      })()]);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.store.dispatch(snapshot => current(snapshot, job) ? probeFailed(snapshot, job, reason.slice(0, 1000)) : snapshot);
      return;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    await this.store.dispatch(snapshot => current(snapshot, job) ? applyManifest(snapshot, job, info) : snapshot);
  }
}
