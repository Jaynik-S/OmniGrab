import type { ProbeJob } from '../core/model.ts';
import { resolveProbeJob } from '../core/reducer.ts';
import { normalizeUrl } from '../core/identity.ts';
import { MAX_MANIFEST_BYTES, validManifestText } from '../manifests/response.ts';
import type { DetectionStore } from './store.ts';

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => { reject(signal.reason ?? new Error('manifest-aborted')); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function replyResponse(value: unknown): Response {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('page-manifest-reply-invalid');
  const reply = value as Record<string, unknown>;
  if (reply.ok === false && typeof reply.error === 'string' && reply.error.length <= 1_000) throw new Error(`page-manifest:${reply.error}`);
  const url = typeof reply.url === 'string' ? normalizeUrl(reply.url) : undefined;
  if (reply.ok !== true || !url || !Number.isInteger(reply.status) || Number(reply.status) < 200 || Number(reply.status) > 299 ||
      !validManifestText(reply.text, MAX_MANIFEST_BYTES)) throw new Error('page-manifest-reply-invalid');
  const response = new Response(reply.status === 204 || reply.status === 205 ? null : reply.text,
    { status: Number(reply.status), headers: { 'content-type': 'text/plain; charset=utf-8' } });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

/** Physical page requests keep their slot until the content reply settles, even after caller timeout. */
function pageSlots() {
  let active = 0;
  const queue: { signal: AbortSignal; resolve: (release: () => void) => void; reject: (error: unknown) => void; abort: () => void }[] = [];
  const releaseSlot = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true; active--;
      while (active < 4 && queue.length) {
        const next = queue.shift()!;
        next.signal.removeEventListener('abort', next.abort);
        if (next.signal.aborted) { next.reject(next.signal.reason); continue; }
        active++; next.resolve(releaseSlot());
      }
    };
  };
  return (signal: AbortSignal): Promise<() => void> => {
    signal.throwIfAborted();
    if (active < 4) { active++; return Promise.resolve(releaseSlot()); }
    if (queue.length >= 200) return Promise.reject(new Error('page-manifest-queue-limit'));
    return new Promise((resolve, reject) => {
      const entry = { signal, resolve, reject, abort: () => {} };
      entry.abort = () => { const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1); reject(signal.reason); };
      queue.push(entry); signal.addEventListener('abort', entry.abort, { once: true });
    });
  };
}

/** Delegate only to a still-current originating document, retaining the job's navigation fence. */
export function createPageManifestFetcher(store: DetectionStore): (job: ProbeJob, signal: AbortSignal) => Promise<Response> {
  const acquire = pageSlots();
  return async (job, signal) => {
    signal.throwIfAborted();
    const url = normalizeUrl(job.url);
    if (!url) throw new Error('manifest-url-invalid');
    const initial = resolveProbeJob(await store.read(), job);
    if (!initial) throw new Error('page-manifest-stale-job');
    const frameIds = [...new Set(initial.child?.frameIds ?? initial.item.frameIds)];
    let lastFailure: Error | undefined;
    for (const frameId of frameIds) {
      signal.throwIfAborted();
      const before = resolveProbeJob(await store.read(), job);
      if (!before) throw new Error('page-manifest-stale-job');
      if (!(before.child?.frameIds ?? before.item.frameIds).includes(frameId)) continue;
      const documentId = before.tab.documents[frameId];
      if (!documentId) continue;
      let frame;
      try { frame = await abortable(chrome.webNavigation.getFrame({ tabId: job.tabId, frameId }), signal); }
      catch { signal.throwIfAborted(); continue; }
      const afterFrame = resolveProbeJob(await store.read(), job);
      if (!afterFrame) throw new Error('page-manifest-stale-job');
      if (!frame || frame.documentId !== documentId || frame.documentLifecycle && frame.documentLifecycle !== 'active' ||
          !normalizeUrl(frame.url) || afterFrame.tab.documents[frameId] !== documentId ||
          !(afterFrame.child?.frameIds ?? afterFrame.item.frameIds).includes(frameId)) continue;
      let reply: unknown;
      try {
        const release = await acquire(signal);
        const current = resolveProbeJob(await store.read(), job);
        if (signal.aborted || !current || current.tab.documents[frameId] !== documentId) {
          release(); signal.throwIfAborted(); throw new Error('page-manifest-stale-document');
        }
        const requestId = crypto.randomUUID();
        const expiresAt = Math.min(job.expiresAt ?? Date.now() + 4_500, Date.now() + 4_500);
        const target = { frameId, documentId };
        const operation = Promise.resolve().then(() => {
          signal.throwIfAborted();
          return chrome.tabs.sendMessage(job.tabId, { type: 'fetch-manifest', url, requestId, expiresAt }, target);
        });
        const cancel = () => { void chrome.tabs.sendMessage(job.tabId, { type: 'cancel-manifest', requestId }, target).catch(() => {}); };
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        const settled = () => { signal.removeEventListener('abort', cancel); release(); };
        void operation.then(settled, settled);
        reply = await abortable(operation, signal);
      }
      catch (error) {
        signal.throwIfAborted();
        lastFailure = new Error(`page-manifest:${(error instanceof Error ? error.message : String(error)).slice(0, 1_000)}`);
        continue;
      }
      signal.throwIfAborted();
      const afterReply = resolveProbeJob(await store.read(), job);
      if (!afterReply || afterReply.tab.documents[frameId] !== documentId ||
          !(afterReply.child?.frameIds ?? afterReply.item.frameIds).includes(frameId)) throw new Error('page-manifest-stale-document');
      try { return replyResponse(reply); }
      catch (error) {
        // A source can be shared by documents with different CORS contexts. Only current owners are tried.
        if (!(error instanceof Error) || !error.message.startsWith('page-manifest:')) throw error;
        lastFailure = error;
      }
    }
    throw lastFailure ?? new Error('page-manifest-document-unavailable');
  };
}
