import { collectResources, observeMedia } from './collector.ts';
import type { CollectedObservation } from './collector.ts';
import { createManifestRequestHandler } from './manifest-fetch.ts';

const pending: CollectedObservation[] = [];
const resourcesSeen = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
let sending = false;

function enqueue(batch: CollectedObservation[]) {
  pending.push(...batch.slice(0, Math.max(0, 500 - pending.length)));
  if (!sending) timer ??= setTimeout(() => void flush(), 75);
}

async function flush() {
  timer = undefined;
  if (sending || !pending.length) return;
  sending = true;
  const observations = pending.splice(0, 100);
  try {
    await chrome.runtime.sendMessage({ type: 'observe', observations, pageUrl: location.href, title: document.title.slice(0, 512) });
  } catch {
    // Navigated documents and reloaded extensions may lose their message channel.
  } finally {
    sending = false;
    if (pending.length) timer = setTimeout(() => void flush(), 75);
  }
}

function resourceEntries(entries: PerformanceEntry[]) {
  const observations = collectResources(entries as PerformanceResourceTiming[], location.href).filter(item => {
    if (resourcesSeen.has(item.url)) return false;
    resourcesSeen.add(item.url);
    if (resourcesSeen.size > 1_000) resourcesSeen.delete(resourcesSeen.values().next().value!);
    return true;
  });
  enqueue(observations);
}

const media = observeMedia(document, location.href, enqueue);
resourceEntries(performance.getEntriesByType('resource'));
if (typeof PerformanceObserver !== 'undefined') {
  try {
    const resources = new PerformanceObserver(list => resourceEntries(list.getEntries()));
    resources.observe({ type: 'resource', buffered: true });
  } catch { /* Resource Timing observation is optional in unsupported frames. */ }
}

const manifestRequests = createManifestRequestHandler(chrome.runtime.id);
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handled = manifestRequests(message, sender, sendResponse);
  if (handled !== undefined) return handled;
  if (!message || message.type !== 'rescan') return;
  media.rescan();
  resourcesSeen.clear();
  resourceEntries(performance.getEntriesByType('resource'));
  sendResponse({ ok: true });
});
