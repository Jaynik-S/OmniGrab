import { normalizeUrl } from '../core/identity.ts';
import { MAX_MANIFEST_BYTES, readManifestBody } from '../manifests/response.ts';

export type PageManifestResult = { ok: true; url: string; text: string; status: number } | { ok: false; error: string };

/** Fetch through this document's normal CORS context; never synthesize authentication headers. */
export async function fetchManifestForPage(value: unknown, options: { timeoutMs?: number; maxBytes?: number; fetcher?: typeof fetch; expiresAt?: number; signal?: AbortSignal } = {}): Promise<PageManifestResult> {
  const url = typeof value === 'string' ? normalizeUrl(value) : undefined;
  if (!url) return { ok: false, error: 'manifest-url-invalid' };
  if (options.expiresAt !== undefined && !Number.isSafeInteger(options.expiresAt)) return { ok: false, error: 'manifest-limits-invalid' };
  const timeoutMs = Math.min(4_500, options.timeoutMs ?? 4_500, options.expiresAt === undefined ? Infinity : options.expiresAt - Date.now());
  if (timeoutMs <= 0) return { ok: false, error: 'manifest-timeout' };
  const maxBytes = Math.min(MAX_MANIFEST_BYTES, options.maxBytes ?? MAX_MANIFEST_BYTES);
  if (![timeoutMs, maxBytes].every(limit => Number.isSafeInteger(limit) && limit > 0)) return { ok: false, error: 'manifest-limits-invalid' };
  const fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
  const controller = new AbortController();
  if (options.signal?.aborted) return { ok: false, error: 'manifest-aborted' };
  let abortExternal: (() => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    abortExternal = () => {
      const error = new Error('manifest-aborted');
      controller.abort(error);
      reject(error);
    };
    options.signal?.addEventListener('abort', abortExternal, { once: true });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error('manifest-timeout');
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([deadline, cancellation, (async (): Promise<PageManifestResult> => {
      const response = await fetcher(url, { credentials: 'same-origin', redirect: 'follow', signal: controller.signal });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        controller.signal.throwIfAborted();
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new Error(`manifest-http:${response.status}`);
      }
      const finalUrl = normalizeUrl(response.url);
      if (!finalUrl) {
        void response.body?.cancel().catch(() => {});
        throw new Error('manifest-response-url-invalid');
      }
      const text = await readManifestBody(response, maxBytes, controller.signal);
      return { ok: true, url: finalUrl, text, status: response.status };
    })()]);
  } catch (error) {
    return { ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 1_000) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortExternal) options.signal?.removeEventListener('abort', abortExternal);
  }
}

/** A page/content script cannot ask this document to fetch arbitrary resources. */
export function isTrustedManifestSender(sender: chrome.runtime.MessageSender, runtimeId: string): boolean {
  if (!runtimeId || sender.id !== runtimeId || sender.tab) return false;
  const origin = `chrome-extension://${runtimeId}`;
  if (sender.origin !== undefined && sender.origin !== origin) return false;
  if (sender.url !== undefined) {
    try {
      const url = new URL(sender.url);
      return url.protocol === 'chrome-extension:' && url.host === runtimeId && !url.username && !url.password;
    } catch { return false; }
  }
  return sender.origin === origin;
}

/** Own the actual page fetch so an expired/canceled background job cannot leave network work behind. */
export function createManifestRequestHandler(runtimeId: string, options: { fetcher?: typeof fetch } = {}) {
  const active = new Map<string, AbortController>();
  const queued = new Map<string, { start: () => void; cancel: () => void }>();
  const canceled = new Set<string>();
  let pumping = false;
  const pump = () => {
    if (pumping) return;
    pumping = true;
    while (active.size < 4 && queued.size) {
      const [requestId, request] = queued.entries().next().value!;
      queued.delete(requestId); request.start();
    }
    pumping = false;
  };
  return (message: unknown, sender: chrome.runtime.MessageSender, reply: (value: PageManifestResult | { ok: true }) => void): boolean | undefined => {
    if (!message || typeof message !== 'object') return;
    const value = message as Record<string, unknown>;
    if (value.type !== 'fetch-manifest' && value.type !== 'cancel-manifest') return;
    if (!isTrustedManifestSender(sender, runtimeId)) return false;
    const requestId = value.requestId;
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) {
      reply({ ok: false, error: 'manifest-request-invalid' }); return false;
    }
    if (value.type === 'cancel-manifest') {
      canceled.add(requestId);
      if (canceled.size > 128) canceled.delete(canceled.values().next().value!);
      active.get(requestId)?.abort(new Error('manifest-aborted'));
      queued.get(requestId)?.cancel();
      reply({ ok: true }); return false;
    }
    if (canceled.delete(requestId)) { reply({ ok: false, error: 'manifest-aborted' }); return false; }
    if (!Number.isSafeInteger(value.expiresAt) || active.has(requestId) || queued.has(requestId)) {
      reply({ ok: false, error: 'manifest-request-invalid' }); return false;
    }
    const expiresAt = Number(value.expiresAt);
    if (expiresAt <= Date.now()) { reply({ ok: false, error: 'manifest-timeout' }); return false; }
    if (queued.size >= 200) { reply({ ok: false, error: 'manifest-queue-limit' }); return false; }
    const controller = new AbortController();
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: PageManifestResult) => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      active.delete(requestId); queued.delete(requestId);
      reply(result); pump();
    };
    const start = () => {
      if (finished) return;
      if (timer !== undefined) clearTimeout(timer);
      if (expiresAt <= Date.now()) { finish({ ok: false, error: 'manifest-timeout' }); return; }
      active.set(requestId, controller);
      void fetchManifestForPage(value.url, { fetcher: options.fetcher, signal: controller.signal, expiresAt }).then(finish);
    };
    if (active.size < 4) start();
    else {
      // A new worker can recover while this document still owns the previous worker's requests.
      // Wait within the caller's deadline instead of persisting a transient capacity failure.
      queued.set(requestId, { start, cancel: () => finish({ ok: false, error: 'manifest-aborted' }) });
      timer = setTimeout(() => finish({ ok: false, error: 'manifest-timeout' }), Math.min(4_500, expiresAt - Date.now()));
    }
    return true;
  };
}
