import type { Observation, ProbeJob, Snapshot } from '../core/model.ts';
import { bindDocument, ingest, navigate, removeTab, retryManifests } from '../core/reducer.ts';
import { DetectionStore } from './store.ts';
import { ManifestProbe } from './manifest-probe.ts';
import { createPageManifestFetcher } from './page-manifest.ts';
import { RequestTracker } from './network.ts';
import { DocumentLifecycle } from './lifecycle.ts';
import type { LifecycleToken } from './lifecycle.ts';
import { persistedText } from '../core/limits.ts';
import { DownloadStore } from '../downloads/store.ts';
import { createDownloadCoordinator, trustedPopup } from '../downloads/coordinator.ts';
import { createBrowserDownloadAdapter } from '../downloads/browser-adapter.ts';
import type { DownloadStartRequest } from '../downloads/model.ts';

const KEY = 'detectionState';
const store = new DetectionStore({
  load: async () => (await chrome.storage.session.get(KEY))[KEY] as Snapshot | undefined,
  save: async snapshot => { await chrome.storage.session.set({ [KEY]: snapshot }); },
});
const probes = new ManifestProbe(store, undefined, { contextFetcher: createPageManifestFetcher(store) });
const requests = new RequestTracker();
const lifecycle = new DocumentLifecycle();
const requestTokens = new Map<string, LifecycleToken>();
const report = (error: unknown) => console.warn('Detection operation failed:', error instanceof Error ? error.message : String(error));
const downloadStore = new DownloadStore({
  load: async () => (await chrome.storage.local.get('downloadState')).downloadState,
  save: async state => { await chrome.storage.local.set({ downloadState: state }); },
});
const downloadAdapter = createBrowserDownloadAdapter(() => store.read(), selection => {
  const token = lifecycle.capture(selection.tabId, selection.frameId);
  return () => lifecycle.current(token);
});
const downloads = createDownloadCoordinator({ store: downloadStore, ...downloadAdapter });
chrome.downloads.onChanged.addListener(() => { void downloads.reconcile(); });

async function accept(observations: Observation[], token: LifecycleToken | undefined) {
  const jobs: ProbeJob[] = [];
  await store.dispatch(state => {
    if (!lifecycle.current(token)) return state;
    for (const observation of observations) {
      const result = ingest(state, observation); state = result.state;
      if (result.probe) jobs.push(result.probe);
    }
    return state;
  });
  if (lifecycle.current(token)) for (const job of jobs) void probes.enqueue(job).catch(report);
}

// Register all event listeners synchronously. Restoration is serialized inside the store.
chrome.webNavigation.onBeforeNavigate.addListener(details => {
  lifecycle.before(details.tabId, details.frameId, details.url);
  if (details.frameId === 0) void store.dispatch(s => navigate(s, details.tabId, details.url, Date.now())).catch(report);
  else void store.dispatch(s => bindDocument(s, details.tabId, details.frameId, `pending:${details.timeStamp}`)).catch(report);
});
chrome.webNavigation.onCommitted.addListener(details => {
  const committed = lifecycle.committed(details.tabId, details.frameId);
  if (!committed) return;
  void store.dispatch(s => {
    if (details.frameId === 0 && (!committed.pending || !s.tabs[details.tabId])) s = navigate(s, details.tabId, details.url, Date.now());
    return bindDocument(s, details.tabId, details.frameId, details.documentId, details.url);
  }).then(() => probes.recover()).catch(report);
});
chrome.webNavigation.onHistoryStateUpdated.addListener(details => {
  if (details.frameId !== 0) return;
  const token = lifecycle.capture(details.tabId, 0);
  void store.dispatch(s => {
    if (!lifecycle.current(token)) return s;
    const tab = s.tabs[details.tabId];
    if (!persistedText(details.url)) return s;
    if (!tab) return navigate(s, details.tabId, details.url, Date.now(), details.documentId);
    if (tab.documentId !== details.documentId || tab.url === details.url) return s;
    return { ...s, revision: s.revision + 1, tabs: { ...s.tabs,
      [details.tabId]: { ...tab, url: details.url, updatedAt: Date.now() } } };
  }).then(s => {
    if (lifecycle.current(token) && s.tabs[details.tabId]?.documentId === details.documentId)
      return chrome.tabs.sendMessage(details.tabId, { type: 'rescan' }).catch(() => undefined);
  }).catch(report);
});
chrome.webNavigation.onErrorOccurred.addListener(details => {
  if (!lifecycle.failed(details.tabId, details.frameId, details.url)) return;
  const token = lifecycle.capture(details.tabId, details.frameId);
  void chrome.webNavigation.getFrame({ tabId: details.tabId, frameId: details.frameId }).then(frame => {
    if (!frame?.documentId || !lifecycle.current(token)) return;
    return store.dispatch(s => lifecycle.current(token)
      ? bindDocument(s, details.tabId, details.frameId, frame.documentId, frame.url) : s);
  }).then(() => probes.recover()).catch(report);
});
chrome.tabs.onRemoved.addListener(tabId => {
  lifecycle.removed(tabId);
  void store.dispatch(s => removeTab(s, tabId)).catch(report);
});

const filter = { urls: ['http://*/*', 'https://*/*'] };
chrome.webRequest.onBeforeRequest.addListener(details => {
  if (details.tabId < 0) return; // Includes this worker's own manifest fetches.
  const token = lifecycle.capture(details.tabId, details.frameId);
  if (token) requestTokens.set(details.requestId, token);
  else requestTokens.delete(details.requestId);
  if (requestTokens.size > 1000) requestTokens.delete(requestTokens.keys().next().value!);
  const context = !token ? Promise.resolve(undefined) : store.dispatch(s => s).then(s => {
    if (!lifecycle.current(token)) return;
    const tab = s.tabs[details.tabId];
    if (!tab || details.documentId && tab.documents[details.frameId] && tab.documents[details.frameId] !== details.documentId) return;
    return { epoch: tab.epoch, pageUrl: tab.url };
  }).catch(() => undefined);
  requests.start(details, context);
}, filter);
chrome.webRequest.onResponseStarted.addListener(details => {
  const token = requestTokens.get(details.requestId); requestTokens.delete(details.requestId);
  void requests.response(details).then(o => o && lifecycle.current(token) ? accept([o], token) : undefined).catch(report);
}, filter, ['responseHeaders']);
chrome.webRequest.onErrorOccurred.addListener(details => { requests.finish(details.requestId); requestTokens.delete(details.requestId); }, filter);
chrome.webRequest.onCompleted.addListener(details => { requests.finish(details.requestId); requestTokens.delete(details.requestId); }, filter);

function claims(value: unknown): Partial<Observation> | undefined {
  if (!value || typeof value !== 'object') return;
  const raw = value as Record<string, unknown>;
  if (typeof raw.url !== 'string' || raw.url.length > 16384 || !['dom', 'resource'].includes(String(raw.method))) return;
  const clean: Record<string, unknown> = { url: raw.url, method: raw.method };
  for (const [name, limit] of [['mime', 256], ['title', 512], ['poster', 16384], ['elementId', 128]] as const) {
    if (typeof raw[name] === 'string' && (name !== 'poster' || raw[name].length <= limit)) clean[name] = raw[name].slice(0, limit);
  }
  for (const name of ['width', 'height', 'duration'] as const) if (typeof raw[name] === 'number' && Number.isFinite(raw[name]) && raw[name] >= 0) clean[name] = raw[name];
  if (raw.role === 'current' || raw.role === 'alternative') clean.role = raw.role;
  return clean as Partial<Observation>;
}

async function message(raw: unknown, sender: chrome.runtime.MessageSender) {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid message');
  const m = raw as Record<string, unknown>;
  if (m.target === 'download-coordinator') {
    if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL('offscreen.html'))
      return { ok: false, error: { code: 'download-sender-invalid', message: 'Invalid download sender' } };
    // This validator deliberately bypasses coordinator serialization: host readiness depends on it.
    if (m.action === 'validate') return { ok: true, valid: await downloadAdapter.validate(m.selection as import('../downloads/model.ts').DownloadSelection) };
    if (m.action === 'changed') return downloads.reconcile();
  }
  if (typeof m.type === 'string' && m.type.startsWith('download-')) {
    if (!trustedPopup(sender, chrome.runtime.id, chrome.runtime.getURL('popup/index.html')))
      return { ok: false, error: { code: 'download-sender-invalid', message: 'Popup required' } };
    if (m.type === 'download-start') return downloads.start(m.request as DownloadStartRequest);
    if (m.type === 'download-cancel' && typeof m.jobId === 'string') return downloads.cancel(m.jobId);
    if (m.type === 'download-retry' && typeof m.jobId === 'string' && typeof m.requestId === 'string') return downloads.retry(m.jobId, m.requestId);
    if (m.type === 'download-snapshot') return downloads.snapshot();
    return { ok: false, error: { code: 'download-message-invalid', message: 'Invalid download request' } };
  }
  if (m.type === 'observe') {
    const tabId = sender.tab?.id; const frameId = sender.frameId ?? 0;
    if (tabId === undefined || !sender.documentId || !Array.isArray(m.observations) || m.observations.length > 100) throw new Error('Invalid observation sender or batch');
    const token = lifecycle.capture(tabId, frameId);
    if (!token) return { ignored: 'navigation-pending' };
    const frame = await chrome.webNavigation.getFrame({ tabId, frameId });
    if (!lifecycle.current(token) || frame?.documentId !== sender.documentId || sender.documentLifecycle && sender.documentLifecycle !== 'active') return { ignored: 'stale-document' };
    const now = Date.now();
    const observations = m.observations.map(claims).filter((v): v is Partial<Observation> => !!v);
    const jobs: ProbeJob[] = [];
    await store.dispatch(s => {
      if (!lifecycle.current(token)) return s;
      if (!s.tabs[tabId]) s = navigate(s, tabId, sender.tab?.url ?? '', now, frameId === 0 ? sender.documentId : undefined);
      const known = s.tabs[tabId].documents[frameId];
      if (known && known !== sender.documentId) return s;
      s = bindDocument(s, tabId, frameId, sender.documentId!);
      for (const claim of observations) {
        const result = ingest(s, { ...claim, tabId, frameId, documentId: sender.documentId, epoch: s.tabs[tabId].epoch, observedAt: now, pageUrl: sender.url } as Observation);
        s = result.state; if (result.probe) jobs.push(result.probe);
      }
      return s;
    });
    if (!lifecycle.current(token)) return { ignored: 'stale-document' };
    for (const job of jobs) void probes.enqueue(job).catch(report);
    return { ok: true };
  }
  // Popup-only controls cannot be invoked by a content-script sender.
  if (sender.tab || !sender.url?.startsWith(chrome.runtime.getURL(''))) throw new Error('Extension page required');
  if (!Number.isSafeInteger(m.tabId) || Number(m.tabId) < 0) throw new Error('Invalid tab ID');
  const tabId = Number(m.tabId);
  if (m.type === 'snapshot') { const state = await store.read(); return { tab: state.tabs[tabId], revision: state.revision, error: store.error }; }
  if (m.type === 'rescan') {
    await store.dispatch(s => retryManifests(s, tabId));
    void probes.recover().catch(report);
    await chrome.tabs.sendMessage(tabId, { type: 'rescan' });
    return { ok: true };
  }
  throw new Error('Unknown message type');
}
chrome.runtime.onMessage.addListener((raw, sender, reply) => {
  if (raw?.target === 'download-host') return;
  void message(raw, sender).then(reply, error => reply({ error: error instanceof Error ? error.message : String(error) }));
  return true;
});
void downloads.reconcile();

void store.read().then(async restored => {
  const tokens = new Map(Object.keys(restored.tabs).map(Number).map(tabId => [tabId, lifecycle.capture(tabId, 0)]));
  const tabs = await chrome.tabs.query({});
  const open = new Set(tabs.map(t => t.id));
  await store.dispatch(s => {
    for (const [tabId, token] of tokens) if (!open.has(tabId) && lifecycle.current(token)) s = removeTab(s, tabId);
    return s;
  });
  await probes.recover();
}).catch(report);
