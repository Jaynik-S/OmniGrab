import { classify, rejectedResponseReason } from './classify.ts';
import { normalizeUrl } from './identity.ts';
import type { ManifestInfo, MediaItem, Observation, ProbeJob, Snapshot, TabState, Variant } from './model.ts';

export const MAX_ITEMS = 200;
export const MAX_DOCUMENTS = 100;
const unique = <T>(a: T[], b: T[], limit = 100) => [...new Set([...a, ...b])].slice(0, limit);
function dropped(tab: TabState, count: number, reason: string): void {
  if (!count) return;
  tab.dropped += count;
  tab.errors = unique(tab.errors, [reason]);
}
function bounded<T>(tab: TabState, a: T[], b: T[], limit: number, reason: string): T[] {
  const all = [...new Set([...a, ...b])];
  dropped(tab, Math.max(0, all.length - limit), reason);
  return all.slice(0, limit);
}
function mergeProvenance(tab: TabState, item: MediaItem, other: Pick<MediaItem, 'methods' | 'frameIds' | 'documentIds' | 'elementIds' | 'firstSeen' | 'lastSeen'>): void {
  item.methods = unique(item.methods, other.methods);
  item.frameIds = bounded(tab, item.frameIds, other.frameIds, 100, 'provenance-limit');
  item.documentIds = bounded(tab, item.documentIds, other.documentIds, 100, 'provenance-limit');
  item.elementIds = bounded(tab, item.elementIds, other.elementIds, 100, 'provenance-limit');
  item.firstSeen = Math.min(item.firstSeen, other.firstSeen);
  item.lastSeen = Math.max(item.lastSeen, other.lastSeen);
}
function detachFrame(tab: TabState, frameId: number): void {
  const documentId = tab.documents[frameId];
  for (const item of Object.values(tab.media)) {
    item.frameIds = item.frameIds.filter(id => id !== frameId);
    if (documentId) item.documentIds = item.documentIds.filter(id => id !== documentId);
    item.elementIds = item.elementIds.filter(id => !id.startsWith(`${frameId}:`));
    if (!item.frameIds.length) delete tab.media[item.id];
  }
  delete tab.documents[frameId];
  if (frameId === 0) delete tab.documentId;
}
export const emptySnapshot = (): Snapshot => ({ version: 1, revision: 0, tabs: {} });
function replace(s: Snapshot, tab: TabState): Snapshot {
  const tabs: Record<string, TabState> = { ...s.tabs, [tab.id]: tab };
  if (Object.keys(tabs).length > 50) {
    const oldest = Object.values(tabs).filter(t => t.id !== tab.id).sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (oldest) {
      delete tabs[oldest.id];
      tabs[tab.id] = { ...tab, dropped: tab.dropped + 1, errors: unique(tab.errors, ['tab-limit']) };
    }
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
  if (!tab.documents[frameId] && Object.keys(tab.documents).length >= MAX_DOCUMENTS) {
    dropped(tab, 1, 'document-limit');
    return replace(s, tab);
  }
  if (tab.documents[frameId]) detachFrame(tab, frameId);
  tab.documents[frameId] = documentId;
  if (frameId === 0) { tab.documentId = documentId; if (url) tab.url = url; }
  return replace(s, tab);
}
export function removeFrame(s: Snapshot, tabId: number, frameId: number): Snapshot {
  const old = s.tabs[tabId];
  if (!old || !old.documents[frameId] && !Object.values(old.media).some(item => item.frameIds.includes(frameId))) return s;
  const tab = structuredClone(old);
  detachFrame(tab, frameId);
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
  if (!url) return { state: s };
  const owner = Object.values(old.media).find(m => m.url !== url && (m.childUrls.includes(url) || m.segmentUrls.includes(url)));
  const rejection = rejectedResponseReason(o);
  if (!classification && !owner && !(rejection && old.media[url])) return { state: s };
  const tab = structuredClone(old);
  if (o.documentId && !tab.documents[o.frameId]) {
    if (Object.keys(tab.documents).length >= MAX_DOCUMENTS) {
      dropped(tab, 1, 'document-limit');
      return { state: replace(s, tab) };
    }
    tab.documents[o.frameId] = o.documentId;
    if (o.frameId === 0) tab.documentId = o.documentId;
  }
  const now = o.observedAt ?? Date.now();
  const existing = tab.media[owner?.id ?? url];
  if (!existing && Object.keys(tab.media).length >= MAX_ITEMS) {
    dropped(tab, 1, 'item-limit');
    return { state: replace(s, tab) };
  }
  // The guard above guarantees classification for every newly created candidate.
  const item: MediaItem = existing ?? { id: url, url, instance: s.revision + 1, type: classification!.kind, status: classification!.status,
    methods: [], frameIds: [], documentIds: [], elementIds: [], firstSeen: now, lastSeen: now, variants: [], childUrls: [], segmentUrls: [], reason: classification!.reason };
  const hadNetworkEvidence = item.methods.includes('network');
  mergeProvenance(tab, item, { methods: [o.method], frameIds: [o.frameId], documentIds: o.documentId ? [o.documentId] : [],
    elementIds: o.elementId ? [`${o.frameId}:${o.elementId}`] : [], firstSeen: now, lastSeen: now });
  const strongerType = !owner && classification && classification.kind !== item.type && !item.methods.includes('manifest') &&
    (classification.probe || o.method === 'network') && (o.method === 'network' || !hadNetworkEvidence);
  if (strongerType) { item.type = classification.kind; item.status = classification.status; item.reason = classification.reason; }
  if (rejection && item.status !== 'unsupported') {
    item.status = 'unresolved'; item.reason = rejection;
  } else if (!owner && classification?.status === 'confirmed' && item.status !== 'unsupported' &&
      (item.type === 'direct') && (o.method === 'network' || !item.reason?.startsWith('network-'))) {
    item.status = 'confirmed'; item.reason = undefined;
  }
  if (!owner) for (const key of ['mime', 'bytes', 'title', 'width', 'height', 'duration', 'poster'] as const) {
    if (key === 'mime' && o.method !== 'network' && hadNetworkEvidence) continue;
    const value = o[key]; if (value !== undefined) Object.assign(item, { [key]: value });
  }
  tab.media[item.id] = item; tab.updatedAt = now;
  if (o.frameId === 0 && o.title) tab.title = o.title;
  const probe = !owner && classification?.probe && (!existing || strongerType) ? { tabId: o.tabId, epoch: tab.epoch, itemId: url, url,
    kind: classification.kind as 'hls' | 'dash', instance: item.instance } : undefined;
  return { state: replace(s, tab), probe };
}
function jobTab(s: Snapshot, job: ProbeJob): TabState | undefined {
  const tab = s.tabs[job.tabId];
  const item = tab?.media[job.itemId];
  return tab?.epoch === job.epoch && item?.url === job.url && item.type === job.kind && item.instance === job.instance ? structuredClone(tab) : undefined;
}
function mergeVariants(tab: TabState, preferred: Variant[], previous: Variant[]): Variant[] {
  const variants = new Map<string, Variant>();
  for (const variant of [...preferred, ...previous]) {
    const key = JSON.stringify([variant.id, variant.url, variant.kind, variant.representationId, variant.group]);
    if (!variants.has(key)) variants.set(key, { ...variant });
  }
  dropped(tab, Math.max(0, variants.size - 20), 'variant-limit');
  return [...variants.values()].slice(0, 20);
}
export function applyManifest(s: Snapshot, job: ProbeJob, info: ManifestInfo): Snapshot {
  const tab = jobTab(s, job); if (!tab) return s;
  const item = tab.media[job.itemId];
  item.type = info.type;
  item.methods = unique(item.methods, ['manifest']);
  item.variants = mergeVariants(tab, info.variants, item.variants); item.live = info.live || item.live === true; item.protected = info.protected || item.protected === true;
  item.childUrls = bounded(tab, item.childUrls, info.childUrls, 10000, 'relationship-limit');
  item.segmentUrls = bounded(tab, item.segmentUrls, info.segmentUrls, 10000, 'relationship-limit');
  if (info.duration !== undefined) item.duration = info.duration;
  // Child evidence may introduce more descendants; revisit until every known row is grouped.
  let grouped: boolean;
  do {
    grouped = false;
    for (const other of Object.values(tab.media)) if (other.id !== item.id && (item.childUrls.includes(other.url) || item.segmentUrls.includes(other.url))) {
      mergeProvenance(tab, item, other);
      item.variants = mergeVariants(tab, item.variants, other.variants);
      item.childUrls = bounded(tab, item.childUrls, other.childUrls, 10000, 'relationship-limit');
      item.segmentUrls = bounded(tab, item.segmentUrls, other.segmentUrls, 10000, 'relationship-limit');
      item.protected = item.protected || other.protected === true; item.live = item.live || other.live === true;
      if (item.duration === undefined && other.duration !== undefined) item.duration = other.duration;
      delete tab.media[other.id]; grouped = true;
    }
  } while (grouped);
  item.status = item.protected ? 'unsupported' : 'confirmed';
  item.reason = item.protected ? 'protected-manifest' : info.truncated ? `variant-limit:${info.truncated}` : undefined;
  if (info.truncated) {
    dropped(tab, info.truncated, 'variant-limit');
  }
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
