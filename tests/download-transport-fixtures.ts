import type { DownloadSelection } from '../src/downloads/model.ts';
import { createDownloadAttachmentHandler } from '../src/content/download-fetch.ts';
export const selection: DownloadSelection = { tabId: 7, frameId: 0, documentId: 'doc', epoch: 1, mediaId: 'm', instance: 1, pageUrl: 'https://page.test/watch', sourceUrl: 'https://cdn.test/master.m3u8', videoUrl: 'https://cdn.test/video.m3u8', filename: 'x.mp4', output: 'mp4' };
export function connectPair(name: string) {
  const listeners = [new Set<(m: unknown) => void>(), new Set<(m: unknown) => void>()];
  const disconnect = [new Set<() => void>(), new Set<() => void>()]; let closed = false;
  const ports = [0, 1].map(i => ({ name, sender: { id: 'test', tab: { id: 7 }, frameId: 0, documentId: 'doc' },
    postMessage: (m: unknown) => { const value = JSON.parse(JSON.stringify(m)); queueMicrotask(() => { if (!closed) for (const f of listeners[1 - i]) f(value); }); },
    onMessage: { addListener: (f: (m: unknown) => void) => listeners[i].add(f), removeListener: (f: (m: unknown) => void) => listeners[i].delete(f) },
    onDisconnect: { addListener: (f: () => void) => disconnect[i].add(f), removeListener: (f: () => void) => disconnect[i].delete(f) },
    disconnect: () => { if (closed) return; closed = true; for (const set of disconnect) for (const f of set) f(); },
  })) as unknown as chrome.runtime.Port[];
  return { host: ports[0], page: ports[1] };
}
export async function attachPage(transport: { expectAttachment: (token: string) => unknown; acceptPort: (port: chrome.runtime.Port) => Promise<boolean> }, fetcher: typeof fetch) {
  const token = 'a'.repeat(48); const payload = transport.expectAttachment(token); let pair!: ReturnType<typeof connectPair>;
  const handler = createDownloadAttachmentHandler('test', { pageUrl: () => selection.pageUrl, fetcher, connect: name => { pair = connectPair(name); return pair.page; } });
  handler(payload, { id: 'test', url: 'chrome-extension://test/worker.js' }, () => {});
  // The job ID is read from the registered capability, keeping fixture requests reusable.
  await transport.acceptPort(pair.host); return pair;
}
