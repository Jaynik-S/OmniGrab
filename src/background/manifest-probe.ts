import type { MediaItem, ProbeJob, Snapshot } from '../core/model.ts';
import { applyManifest, probeFailed, probeStarted, resolveProbeJob } from '../core/reducer.ts';
import { normalizeUrl } from '../core/identity.ts';
import { parseHls } from '../manifests/hls.ts';
import { parseDash } from '../manifests/dash.ts';
import { readManifestBody } from '../manifests/response.ts';
import type { DetectionStore } from './store.ts';

export interface ManifestProbeOptions {
  concurrency?: number;
  timeoutMs?: number;
  maxBytes?: number;
  contextFetcher?: (job: ProbeJob, signal: AbortSignal) => Promise<Response>;
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
  const target = resolveProbeJob(snapshot, job);
  return !!target && (target.child ? target.child.status === 'observed' || target.child.status === 'probing' : pending(target.item));
}
const keyOf = (job: ProbeJob) => JSON.stringify([job.tabId, job.epoch, job.ownerId, job.url, job.instance]);

function pendingJobs(snapshot: Snapshot): ProbeJob[] {
  return Object.values(snapshot.tabs).flatMap(tab => Object.values(tab.media).flatMap(item => [
    ...(pending(item) ? [{ tabId: tab.id, epoch: tab.epoch, itemId: item.id, url: item.url, kind: item.type as 'hls' | 'dash', instance: item.instance }] : []),
    ...(item.childManifests ?? []).filter(child => child.status === 'observed' || child.status === 'probing').map(child => ({
      tabId: tab.id, epoch: tab.epoch, itemId: child.url, url: child.url, kind: 'hls' as const, instance: child.instance, ownerId: item.id,
    })),
  ]));
}

/** Durable statuses are the pending queue; in-memory maps only coalesce callers and active work. */
export class ManifestProbe {
  private store: DetectionStore;
  private fetcher: typeof fetch;
  private concurrency: number;
  private timeoutMs: number;
  private maxBytes: number;
  private contextFetcher?: ManifestProbeOptions['contextFetcher'];
  private active = new Map<string, ProbeJob>();
  private activeAliases = new Map<string, Set<string>>();
  private failed = new Set<string>();
  private completions = new Map<string, Completion>();
  private scheduling = Promise.resolve();

  constructor(store: DetectionStore, fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init), options: ManifestProbeOptions = {}) {
    this.store = store;
    this.fetcher = fetcher;
    this.concurrency = Math.min(4, options.concurrency ?? 4);
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    this.contextFetcher = options.contextFetcher;
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
    const snapshot = await this.store.read();
    const jobs = pendingJobs(snapshot);
    const keys = new Set(jobs.map(keyOf));
    for (const key of this.failed) if (!keys.has(key) && !this.active.has(key)) this.failed.delete(key);
    for (const [key, completion] of this.completions) {
      if ((!keys.has(key) || this.failed.has(key)) && !this.active.has(key)) {
        completion.resolve(); this.completions.delete(key);
      }
    }
    for (const job of jobs) {
      const key = keyOf(job);
      if (this.active.has(key) || this.failed.has(key)) continue;
      // A standalone rendition can move into a master while its fetch is running.
      // Match its current owner as well as its instance; separate masters sharing a URL stay separate.
      const target = resolveProbeJob(snapshot, job);
      const running = [...this.active].find(([, active]) => active.tabId === job.tabId && active.epoch === job.epoch &&
        active.url === job.url && active.instance === job.instance && target &&
        resolveProbeJob(snapshot, active)?.item.id === target.item.id);
      if (running) {
        const aliases = this.activeAliases.get(running[0]) ?? new Set<string>();
        aliases.add(key); this.activeAliases.set(running[0], aliases);
        continue;
      }
      if (this.active.size >= this.concurrency) continue;
      this.active.set(key, job);
      const ownedKeys = () => [key, ...(this.activeAliases.get(key) ?? [])];
      void this.run(job).then(() => {
        for (const completed of ownedKeys()) this.completions.get(completed)?.resolve();
      }, error => {
        // A storage failure leaves durable pending work for a future worker, without a retry loop here.
        for (const failed of ownedKeys()) { this.failed.add(failed); this.completions.get(failed)?.reject(error); }
      }).finally(() => {
        for (const completed of ownedKeys()) this.completions.delete(completed);
        this.active.delete(key);
        this.activeAliases.delete(key);
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
    const expiresAt = Date.now() + this.timeoutMs;
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
        const parseResponse = async (response: Response) => {
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
          const body = await readManifestBody(response, this.maxBytes, controller.signal);
          return job.kind === 'hls' ? parseHls(body, base) : parseDash(body, base);
        };
        try {
          return await parseResponse(await this.fetcher(job.url, { credentials: 'include', signal: controller.signal, redirect: 'follow' }));
        } catch (primary) {
          if (!this.contextFetcher || controller.signal.aborted || !current(await this.store.read(), job)) throw primary;
          try {
            return await parseResponse(await this.contextFetcher({ ...job, expiresAt }, controller.signal));
          } catch (fallback) {
            const message = (error: unknown) => error instanceof Error ? error.message : String(error);
            throw new Error(`${message(primary)};page-context:${message(fallback)}`.slice(0, 1000));
          }
        }
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
