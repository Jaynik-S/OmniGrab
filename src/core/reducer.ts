import { classify } from './classify.ts';
import { normalizeUrl } from './identity.ts';
import type { ManifestInfo, MediaItem, Observation, ProbeJob, Snapshot, TabState } from './model.ts';

export const MAX_ITEMS = 200;
const unique = <T>(a: T[], b: T[], limit = 100) => [...new Set([...a, ...b])].slice(0, limit);
export const emptySnapshot = (): Snapshot => ({ version: 1, revision: 0, tabs: {} });
function replace(s: Snapshot, tab: TabState): Snapshot {
  const tabs: Record<string, TabState> = { ...s.tabs, [tab.id]: tab };
  if (Object.keys(tabs).length > 50) {
    const oldest = Object.values(tabs).filter(t => t.id !== tab.id).sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (oldest) delete tabs[oldest.id];
  }
  return { ...s, revision: s.revision + 1, tabs };
}
export function navigate(s: Snapshot, tabId: number, url: string, now: number, documentId?: string): Snapshot {
  return replace(s, { id: tabId, url, epoch: (s.tabs[tabId]?.epoch ?? 0) + 1, documentId,
    documents: documentId ? { 0: documentId } : {}, media: {}, updatedAt: now, dropped: 0, errors: [] });
}
export function bindDocument(s: Snapshot, tabId: number, frameId: number, documentId: string, url?: string): Snapshot {
  const old = s.tabs[tabId];
  if (!old || old.documents[frameId] === documentId) return s;
  const tab = structuredClone(old);
  if (tab.documents[frameId]) {
    for (const item of Object.values(tab.media)) {
      item.frameIds = item.frameIds.filter(id => id !== frameId);
      item.documentIds = item.documentIds.filter(id => id !== tab.documents[frameId]);
      if (!item.frameIds.length) delete tab.media[item.id];
    }
  }
  tab.documents[frameId] = documentId;
  if (frameId === 0) { tab.documentId = documentId; if (url) tab.url = url; }
  return replace(s, tab);
}
export function removeTab(s: Snapshot, tabId: number): Snapshot {
  if (!s.tabs[tabId]) return s;
  const tabs = { ...s.tabs }; delete tabs[tabId];
  return { ...s, revision: s.revision + 1, tabs };
}
export function ingest(s: Snapshot, o: Observation): { state: Snapshot; probe?: ProbeJob } {
  const old = s.tabs[o.tabId];
  if (!old || o.epoch !== undefined && o.epoch !== old.epoch || o.documentId && old.documents[o.frameId] && o.documentId !== old.documents[o.frameId]) return { state: s };
  const classification = classify(o);
  const url = classification?.kind === 'blob' ? o.url : normalizeUrl(o.url);
  if (!classification || !url) return { state: s };
  if (Object.values(old.media).some(m => m.url !== url && (m.childUrls.includes(url) || m.segmentUrls.includes(url)))) return { state: s };
  const tab = structuredClone(old);
  const now = o.observedAt ?? Date.now();
  const existing = tab.media[url];
  if (!existing && Object.keys(tab.media).length >= MAX_ITEMS) return { state: replace(s, { ...tab, dropped: tab.dropped + 1 }) };
  const item: MediaItem = existing ?? { id: url, url, type: classification.kind, status: classification.status,
    methods: [], frameIds: [], documentIds: [], elementIds: [], firstSeen: now, lastSeen: now, variants: [], childUrls: [], segmentUrls: [], reason: classification.reason };
  item.methods = unique(item.methods, [o.method]);
  item.frameIds = unique(item.frameIds, [o.frameId]);
  item.documentIds = unique(item.documentIds, o.documentId ? [o.documentId] : []);
  item.elementIds = unique(item.elementIds, o.elementId ? [`${o.frameId}:${o.elementId}`] : []);
  item.firstSeen = Math.min(item.firstSeen, now); item.lastSeen = Math.max(item.lastSeen, now);
  if (classification.status === 'confirmed' && item.status !== 'unsupported') item.status = 'confirmed';
  for (const key of ['mime', 'bytes', 'title', 'width', 'height', 'duration', 'poster'] as const) {
    const value = o[key]; if (value !== undefined) Object.assign(item, { [key]: value });
  }
  tab.media[url] = item; tab.updatedAt = now;
  if (o.frameId === 0 && o.title) tab.title = o.title;
  const probe = classification.probe && !existing ? { tabId: o.tabId, epoch: tab.epoch, itemId: url, url, kind: classification.kind as 'hls' | 'dash' } : undefined;
  return { state: replace(s, tab), probe };
}
function jobTab(s: Snapshot, job: ProbeJob): TabState | undefined {
  const tab = s.tabs[job.tabId];
  return tab?.epoch === job.epoch && tab.media[job.itemId] ? structuredClone(tab) : undefined;
}
export function applyManifest(s: Snapshot, job: ProbeJob, info: ManifestInfo): Snapshot {
  const tab = jobTab(s, job); if (!tab) return s;
  const item = tab.media[job.itemId];
  item.type = info.type; item.status = info.protected ? 'unsupported' : 'confirmed';
  item.reason = info.protected ? 'protected-manifest' : info.truncated ? `variant-limit:${info.truncated}` : undefined;
  item.methods = unique(item.methods, ['manifest']);
  item.variants = info.variants.slice(0, 20); item.live = info.live; item.protected = info.protected;
  item.childUrls = unique([], info.childUrls, 10000); item.segmentUrls = unique([], info.segmentUrls, 10000);
  if (info.duration !== undefined) item.duration = info.duration;
  for (const other of Object.values(tab.media)) if (other.id !== item.id && (item.childUrls.includes(other.url) || item.segmentUrls.includes(other.url))) {
    item.methods = unique(item.methods, other.methods); item.frameIds = unique(item.frameIds, other.frameIds);
    item.documentIds = unique(item.documentIds, other.documentIds); delete tab.media[other.id];
  }
  tab.dropped += info.truncated ?? 0;
  return replace(s, tab);
}
export function probeFailed(s: Snapshot, job: ProbeJob, reason: string): Snapshot {
  const tab = jobTab(s, job); if (!tab) return s;
  Object.assign(tab.media[job.itemId], { status: 'unresolved', reason });
  return replace(s, tab);
}
export function probeStarted(s: Snapshot, job: ProbeJob): Snapshot {
  const tab = jobTab(s, job); if (!tab) return s;
  tab.media[job.itemId].status = 'probing';
  return replace(s, tab);
}
