import type { Observation, ProbeJob, Snapshot } from '../core/model.ts';
import { bindDocument, ingest, navigate, removeTab } from '../core/reducer.ts';
import { DetectionStore } from './store.ts';
import { ManifestProbe } from './manifest-probe.ts';
import { RequestTracker } from './network.ts';

const KEY = 'detectionState';
const store = new DetectionStore({
  load: async () => (await chrome.storage.session.get(KEY))[KEY] as Snapshot | undefined,
  save: async snapshot => { await chrome.storage.session.set({ [KEY]: snapshot }); },
});
const probes = new ManifestProbe(store);
const requests = new RequestTracker();
const pendingFrames = new Set<string>();
const frameKey = (tab: number, frame: number) => `${tab}:${frame}`;
const report = (error: unknown) => console.warn('Detection operation failed:', error instanceof Error ? error.message : String(error));

async function accept(observations: Observation[]) {
  const jobs: ProbeJob[] = [];
  await store.dispatch(state => {
    for (const observation of observations) {
      const result = ingest(state, observation); state = result.state;
      if (result.probe) jobs.push(result.probe);
    }
    return state;
  });
  for (const job of jobs) void probes.enqueue(job).catch(report);
}

// Register all event listeners synchronously. Restoration is serialized inside the store.
chrome.webNavigation.onBeforeNavigate.addListener(details => {
  if (details.frameId === 0) for (const key of pendingFrames) if (key.startsWith(`${details.tabId}:`)) pendingFrames.delete(key);
  pendingFrames.add(frameKey(details.tabId, details.frameId));
  if (pendingFrames.size > 1000) pendingFrames.delete(pendingFrames.values().next().value!);
  if (details.frameId === 0) void store.dispatch(s => navigate(s, details.tabId, details.url, Date.now())).catch(report);
  else void store.dispatch(s => bindDocument(s, details.tabId, details.frameId, `pending:${details.timeStamp}`)).catch(report);
});
chrome.webNavigation.onCommitted.addListener(details => {
  const pending = pendingFrames.delete(frameKey(details.tabId, details.frameId));
  void store.dispatch(s => {
    if (details.frameId === 0 && (!pending || !s.tabs[details.tabId])) s = navigate(s, details.tabId, details.url, Date.now());
    return bindDocument(s, details.tabId, details.frameId, details.documentId, details.url);
  }).then(() => probes.recover()).catch(report);
});
chrome.webNavigation.onHistoryStateUpdated.addListener(details => {
  if (details.frameId !== 0) return;
  void store.dispatch(s => navigate(s, details.tabId, details.url, Date.now(), details.documentId))
    .then(() => chrome.tabs.sendMessage(details.tabId, { type: 'rescan' }).catch(() => undefined)).catch(report);
});
chrome.webNavigation.onErrorOccurred.addListener(details => { pendingFrames.delete(frameKey(details.tabId, details.frameId)); });
chrome.tabs.onRemoved.addListener(tabId => {
  for (const key of pendingFrames) if (key.startsWith(`${tabId}:`)) pendingFrames.delete(key);
  void store.dispatch(s => removeTab(s, tabId)).catch(report);
});

const filter = { urls: ['http://*/*', 'https://*/*'] };
chrome.webRequest.onBeforeRequest.addListener(details => {
  if (details.tabId < 0) return; // Includes this worker's own manifest fetches.
  const pending = pendingFrames.has(frameKey(details.tabId, details.frameId));
  const context = pending ? Promise.resolve(undefined) : store.dispatch(s => s).then(s => {
    const tab = s.tabs[details.tabId];
    if (!tab || details.documentId && tab.documents[details.frameId] && tab.documents[details.frameId] !== details.documentId) return;
    return { epoch: tab.epoch, pageUrl: tab.url };
  }).catch(() => undefined);
  requests.start(details, context);
}, filter);
chrome.webRequest.onResponseStarted.addListener(details => {
  void requests.response(details).then(o => o ? accept([o]) : undefined).catch(report);
}, filter, ['responseHeaders']);
chrome.webRequest.onErrorOccurred.addListener(details => requests.finish(details.requestId), filter);
chrome.webRequest.onCompleted.addListener(details => requests.finish(details.requestId), filter);

function claims(value: unknown): Partial<Observation> | undefined {
  if (!value || typeof value !== 'object') return;
  const raw = value as Record<string, unknown>;
  if (typeof raw.url !== 'string' || raw.url.length > 16384 || !['dom', 'resource'].includes(String(raw.method))) return;
  const clean: Record<string, unknown> = { url: raw.url, method: raw.method };
  for (const [name, limit] of [['mime', 256], ['title', 512], ['poster', 16384], ['elementId', 128]] as const) {
    if (typeof raw[name] === 'string') clean[name] = raw[name].slice(0, limit);
  }
  for (const name of ['width', 'height', 'duration'] as const) if (typeof raw[name] === 'number' && Number.isFinite(raw[name]) && raw[name] >= 0) clean[name] = raw[name];
  if (raw.role === 'current' || raw.role === 'alternative') clean.role = raw.role;
  return clean as Partial<Observation>;
}

async function message(raw: unknown, sender: chrome.runtime.MessageSender) {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid message');
  const m = raw as Record<string, unknown>;
  if (m.type === 'observe') {
    const tabId = sender.tab?.id; const frameId = sender.frameId ?? 0;
    if (tabId === undefined || !sender.documentId || !Array.isArray(m.observations) || m.observations.length > 100) throw new Error('Invalid observation sender or batch');
    if (pendingFrames.has(frameKey(tabId, frameId))) return { ignored: 'navigation-pending' };
    const frame = await chrome.webNavigation.getFrame({ tabId, frameId });
    if (frame?.documentId !== sender.documentId || sender.documentLifecycle && sender.documentLifecycle !== 'active') return { ignored: 'stale-document' };
    const now = Date.now();
    const observations = m.observations.map(claims).filter((v): v is Partial<Observation> => !!v);
    const jobs: ProbeJob[] = [];
    await store.dispatch(s => {
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
    for (const job of jobs) void probes.enqueue(job).catch(report);
    return { ok: true };
  }
  // Popup-only controls cannot be invoked by a content-script sender.
  if (sender.tab || !sender.url?.startsWith(chrome.runtime.getURL(''))) throw new Error('Extension page required');
  if (!Number.isSafeInteger(m.tabId) || Number(m.tabId) < 0) throw new Error('Invalid tab ID');
  const tabId = Number(m.tabId);
  if (m.type === 'snapshot') { const state = await store.read(); return { tab: state.tabs[tabId], revision: state.revision, error: store.error }; }
  if (m.type === 'rescan') {
    await chrome.tabs.sendMessage(tabId, { type: 'rescan' });
    return { ok: true };
  }
  throw new Error('Unknown message type');
}
chrome.runtime.onMessage.addListener((raw, sender, reply) => {
  void message(raw, sender).then(reply, error => reply({ error: error instanceof Error ? error.message : String(error) }));
  return true;
});

void store.read().then(async () => {
  const tabs = await chrome.tabs.query({});
  const open = new Set(tabs.map(t => t.id));
  await store.dispatch(s => { for (const tabId of Object.keys(s.tabs).map(Number)) if (!open.has(tabId)) s = removeTab(s, tabId); return s; });
  await probes.recover();
}).catch(report);
