import { classify, rejectedResponseReason } from './classify.ts';
import { normalizeUrl } from './identity.ts';
import type { ChildManifest, ManifestInfo, MediaItem, Observation, ProbeJob, SegmentPattern, Snapshot, TabState, Variant } from './model.ts';
import { matchesSegmentPattern, MAX_SEGMENT_PATTERNS, segmentPatternKey } from './segments.ts';
import { boundedManifestValues, MAX_CHILD_MANIFESTS, MAX_REFERENCE_CHARS, persistedText } from './limits.ts';

export const MAX_ITEMS = 200;
export const MAX_DOCUMENTS = 100;
export const MAX_PROBE_ATTEMPTS = 3;
const unique = <T>(a: T[], b: T[], limit = 100) => [...new Set([...a, ...b])].slice(0, limit);
const mergeLive = (a: boolean | undefined, b: boolean | undefined): boolean | undefined => a === true || b === true ? true : a ?? b;
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
function mergeReferences(tab: TabState, item: MediaItem, incoming: Pick<ManifestInfo, 'childUrls' | 'segmentUrls'>): void {
  let size = 0;
  for (const key of ['childUrls', 'segmentUrls'] as const) {
    const all = [...new Set([...item[key], ...incoming[key]])];
    item[key] = all.filter((url, index) => {
      if (index >= 10000 || size + url.length > MAX_REFERENCE_CHARS) { dropped(tab, 1, 'relationship-limit'); return false; }
      size += url.length;
      return true;
    });
  }
}
function rememberChild(tab: TabState, item: MediaItem, child: ChildManifest): ChildManifest | undefined {
  const work = item.childManifests ??= [];
  const existing = work.find(previous => previous.url === child.url);
  if (existing) {
    existing.frameIds = bounded(tab, existing.frameIds, child.frameIds, 100, 'provenance-limit');
    return existing;
  }
  if (work.length >= MAX_CHILD_MANIFESTS) { dropped(tab, 1, 'child-manifest-limit'); return; }
  work.push(structuredClone(child));
  return work[work.length - 1];
}
function mergeProvenance(tab: TabState, item: MediaItem, other: Pick<MediaItem, 'methods' | 'frameIds' | 'documentIds' | 'elementIds' | 'firstSeen' | 'lastSeen'>): void {
  item.methods = unique(item.methods, other.methods);
  item.frameIds = bounded(tab, item.frameIds, other.frameIds, 100, 'provenance-limit');
  item.documentIds = bounded(tab, item.documentIds, other.documentIds, 100, 'provenance-limit');
  item.elementIds = bounded(tab, item.elementIds, other.elementIds, 100, 'provenance-limit');
  item.firstSeen = Math.min(item.firstSeen, other.firstSeen);
  item.lastSeen = Math.max(item.lastSeen, other.lastSeen);
}
function ownsUrl(item: MediaItem, url: string): boolean {
  return item.childUrls.includes(url) || item.segmentUrls.includes(url) ||
    item.segmentPatterns?.some(pattern => matchesSegmentPattern(url, pattern)) === true;
}
function mergeSegmentPatterns(tab: TabState, item: MediaItem, incoming: SegmentPattern[] | undefined): void {
  if (!incoming?.length) return;
  const patterns = new Map<string, SegmentPattern>();
  for (const pattern of [...(item.segmentPatterns ?? []), ...incoming]) {
    const key = segmentPatternKey(pattern);
    if (!patterns.has(key)) patterns.set(key, { literals: [...pattern.literals], minDigits: [...pattern.minDigits], variables: [...pattern.variables] });
  }
  dropped(tab, Math.max(0, patterns.size - MAX_SEGMENT_PATTERNS), 'relationship-limit');
  item.segmentPatterns = [...patterns.values()].slice(0, MAX_SEGMENT_PATTERNS);
}
function detachFrame(tab: TabState, frameId: number, instance: number): void {
  const documentId = tab.documents[frameId];
  for (const item of Object.values(tab.media)) {
    if (item.childManifests) item.childManifests = item.childManifests.filter(child => {
      if (!child.frameIds.includes(frameId)) return true;
      child.frameIds = child.frameIds.filter(id => id !== frameId);
      child.instance = instance;
      if (child.status === 'probing') child.status = 'observed';
      return child.frameIds.length > 0;
    });
    const removedProvenance = item.frameIds.includes(frameId) || documentId !== undefined && item.documentIds.includes(documentId) ||
      item.elementIds.some(id => id.startsWith(`${frameId}:`));
    item.frameIds = item.frameIds.filter(id => id !== frameId);
    if (documentId) item.documentIds = item.documentIds.filter(id => id !== documentId);
    item.elementIds = item.elementIds.filter(id => !id.startsWith(`${frameId}:`));
    if (!item.frameIds.length) delete tab.media[item.id];
    else if (removedProvenance) {
      // Shared URLs survive the frame, but work started against its old membership cannot.
      item.instance = instance;
      if (item.status === 'probing') item.status = 'observed';
    }
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
  const invalid = !persistedText(url) || documentId !== undefined && !persistedText(documentId);
  if (!persistedText(url)) url = '';
  if (documentId !== undefined && !persistedText(documentId)) documentId = undefined;
  return replace(s, { id: tabId, url, epoch: (s.tabs[tabId]?.epoch ?? 0) + 1, documentId,
    documents: documentId ? { 0: documentId } : {}, media: {}, updatedAt: now, dropped: invalid ? 1 : 0, errors: invalid ? ['value-limit'] : [] });
}
export function bindDocument(s: Snapshot, tabId: number, frameId: number, documentId: string, url?: string): Snapshot {
  const old = s.tabs[tabId];
  if (!old || old.documents[frameId] === documentId) return s;
  const tab = structuredClone(old);
  if (!persistedText(documentId) || url !== undefined && !persistedText(url)) {
    dropped(tab, 1, 'value-limit'); return replace(s, tab);
  }
  if (!tab.documents[frameId] && Object.keys(tab.documents).length >= MAX_DOCUMENTS) {
    dropped(tab, 1, 'document-limit');
    return replace(s, tab);
  }
  if (tab.documents[frameId]) detachFrame(tab, frameId, s.revision + 1);
  tab.documents[frameId] = documentId;
  if (frameId === 0) { tab.documentId = documentId; if (url) tab.url = url; }
  return replace(s, tab);
}
export function removeFrame(s: Snapshot, tabId: number, frameId: number): Snapshot {
  const old = s.tabs[tabId];
  if (!old || !old.documents[frameId] && !Object.values(old.media).some(item => item.frameIds.includes(frameId))) return s;
  const tab = structuredClone(old);
  detachFrame(tab, frameId, s.revision + 1);
  return replace(s, tab);
}
export function removeTab(s: Snapshot, tabId: number): Snapshot {
  if (!s.tabs[tabId]) return s;
  const tabs = { ...s.tabs }; delete tabs[tabId];
  return { ...s, revision: s.revision + 1, tabs };
}
/** Explicit user action retries failures once; repeated inventories and worker wakes do not. */
export function retryManifests(s: Snapshot, tabId: number): Snapshot {
  const previous = s.tabs[tabId];
  if (!previous) return s;
  const tab = structuredClone(previous);
  let changed = false;
  const retry = (work: MediaItem | ChildManifest) => {
    if (work.status !== 'unresolved') return;
    if (work.reason) tab.errors = unique(tab.errors, [`manifest-retry:${work.reason}:${work.url}`.slice(0, 1000)]);
    Object.assign(work, { status: 'observed', instance: s.revision + 1, probeAttempts: 0, reason: undefined });
    changed = true;
  };
  for (const item of Object.values(tab.media)) {
    if (item.type !== 'hls' && item.type !== 'dash') continue;
    retry(item);
    for (const child of item.childManifests ?? []) retry(child);
  }
  return changed ? replace(s, tab) : s;
}
export function ingest(s: Snapshot, o: Observation): { state: Snapshot; probe?: ProbeJob } {
  const old = s.tabs[o.tabId];
  if (!old || o.epoch !== undefined && o.epoch !== old.epoch || o.documentId && old.documents[o.frameId] && o.documentId !== old.documents[o.frameId]) return { state: s };
  const classification = classify(o);
  const url = classification?.kind === 'blob' ? o.url : normalizeUrl(o.url);
  if (!url) return { state: s };
  const owner = Object.values(old.media).find(m => m.url !== url && ownsUrl(m, url));
  const rejection = rejectedResponseReason(o);
  if (!classification && !owner && !(rejection && old.media[url])) return { state: s };
  const tab = structuredClone(old);
  if (!persistedText(url) || o.documentId !== undefined && !persistedText(o.documentId)) {
    dropped(tab, 1, 'value-limit'); return { state: replace(s, tab) };
  }
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
    const strength = (status: string, type: string) => status === 'confirmed' || status === 'unsupported' ? 3 : type === 'hls' || type === 'dash' ? 2 : 1;
    const incoming = strength(classification!.status, classification!.kind);
    const weakest = Object.values(tab.media).filter(candidate => strength(candidate.status, candidate.type) < incoming)
      .sort((a, b) => strength(a.status, a.type) - strength(b.status, b.type) || a.firstSeen - b.firstSeen)[0];
    if (!weakest) { dropped(tab, 1, 'item-limit'); return { state: replace(s, tab) }; }
    delete tab.media[weakest.id];
    dropped(tab, 1, 'item-evicted');
  }
  // The guard above guarantees classification for every newly created candidate.
  const item: MediaItem = existing ?? { id: url, url, instance: s.revision + 1, type: classification!.kind, status: classification!.status,
    methods: [], frameIds: [], documentIds: [], elementIds: [], firstSeen: now, lastSeen: now, variants: [], childUrls: [], segmentUrls: [], reason: classification!.reason };
  const hadNetworkEvidence = item.methods.includes('network');
  mergeProvenance(tab, item, { methods: [o.method], frameIds: [o.frameId], documentIds: o.documentId ? [o.documentId] : [],
    elementIds: o.elementId && persistedText(`${o.frameId}:${o.elementId}`) ? [`${o.frameId}:${o.elementId}`] : [], firstSeen: now, lastSeen: now });
  const strongerType = !owner && classification && classification.kind !== item.type && !item.methods.includes('manifest') &&
    (classification.probe || o.method === 'network') && (o.method === 'network' || !hadNetworkEvidence);
  if (strongerType) { item.type = classification.kind; item.status = classification.status; item.reason = classification.reason; }
  const freshSuccess = o.method === 'network' && o.statusCode !== undefined && o.statusCode >= 200 && o.statusCode < 300;
  const retry = !owner && classification?.probe && freshSuccess && item.status === 'unresolved' && (item.probeAttempts ?? 0) < MAX_PROBE_ATTEMPTS;
  if (retry) Object.assign(item, { status: 'observed', instance: s.revision + 1, reason: undefined });
  if (rejection && owner) {
    tab.errors = unique(tab.errors, [`child-response:${rejection}:${url}`.slice(0, 1000)]);
  } else if (rejection && item.status !== 'unsupported' &&
      !(classification?.probe && !rejection.startsWith('network-http:'))) {
    item.status = 'unresolved'; item.reason = rejection.slice(0, 1000);
  } else if (!owner && classification?.status === 'confirmed' && item.status !== 'unsupported' &&
      (item.type === 'direct') && (o.method === 'network' || !item.reason?.startsWith('network-'))) {
    item.status = 'confirmed'; item.reason = undefined;
  }
  if (!owner) for (const key of ['mime', 'bytes', 'title', 'width', 'height', 'duration', 'poster'] as const) {
    if (key === 'mime' && o.method !== 'network' && hadNetworkEvidence) continue;
    const value = o[key];
    if (value !== undefined) {
      if (typeof value === 'string' ? persistedText(value) : Number.isFinite(value)) Object.assign(item, { [key]: value });
      else dropped(tab, 1, 'value-limit');
    }
  }
  tab.media[item.id] = item; tab.updatedAt = now;
  if (o.frameId === 0 && o.title && persistedText(o.title)) tab.title = o.title;
  let probe: ProbeJob | undefined = !owner && classification?.probe && (!existing || strongerType || retry) ? { tabId: o.tabId, epoch: tab.epoch, itemId: url, url,
    kind: classification.kind as 'hls' | 'dash', instance: item.instance } : undefined;
  if (owner && item.type === 'hls' && item.childUrls.includes(url) && !rejection?.startsWith('network-http:')) {
    const child = rememberChild(tab, item, { url, instance: s.revision + 1, status: 'observed', frameIds: [o.frameId] });
    if (child?.status === 'unresolved' && freshSuccess && (child.probeAttempts ?? 0) < MAX_PROBE_ATTEMPTS)
      Object.assign(child, { status: 'observed', instance: s.revision + 1, reason: undefined });
    if (child && (child.status === 'observed' || child.status === 'probing')) probe = { tabId: tab.id, epoch: tab.epoch, itemId: url, url, kind: 'hls', instance: child.instance, ownerId: item.id };
  }
  return { state: replace(s, tab), probe };
}

/** Resolve both ordinary jobs and child jobs transferred to a current owner during grouping. */
export function resolveProbeJob(s: Snapshot, job: ProbeJob): { tab: TabState; item: MediaItem; child?: ChildManifest } | undefined {
  const tab = s.tabs[job.tabId];
  if (!tab || tab.epoch !== job.epoch) return;
  const item = tab?.media[job.itemId];
  if (!job.ownerId && item?.url === job.url && item.type === job.kind && item.instance === job.instance) return { tab, item };
  if (job.kind !== 'hls' || job.itemId !== job.url) return;
  for (const owner of Object.values(tab.media)) {
    if (job.ownerId && owner.id !== job.ownerId) continue;
    const child = owner.childManifests?.find(work => work.url === job.url && work.instance === job.instance);
    if (owner.type === 'hls' && child) return { tab, item: owner, child };
  }
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
  const target = resolveProbeJob(s, job); if (!target) return s;
  if (!boundedManifestValues(info)) return probeFailed(s, job, 'manifest-value-limit');
  const tab = structuredClone(target.tab);
  const item = tab.media[target.item.id];
  if (target.child) item.childManifests!.find(child => child.url === job.url)!.status = 'confirmed';
  item.type = info.type;
  item.methods = unique(item.methods, ['manifest']);
  item.variants = target.child ? mergeVariants(tab, item.variants, info.variants) : mergeVariants(tab, info.variants, item.variants);
  item.live = mergeLive(info.live, item.live); item.protected = info.protected || item.protected === true;
  mergeReferences(tab, item, info);
  mergeSegmentPatterns(tab, item, info.segmentPatterns);
  if (info.duration !== undefined) item.duration = info.duration;
  // Child evidence may introduce more descendants; revisit until every known row is grouped.
  let grouped: boolean;
  do {
    grouped = false;
    for (const other of Object.values(tab.media)) if (other.id !== item.id && ownsUrl(item, other.url)) {
      mergeProvenance(tab, item, other);
      if (item.type === 'hls' && item.childUrls.includes(other.url)) {
        rememberChild(tab, item, { url: other.url, instance: other.instance, frameIds: other.frameIds,
          probeAttempts: other.probeAttempts, reason: other.reason,
          status: other.type !== 'hls' ? 'observed' : other.status === 'unsupported' ? 'confirmed' : other.status });
        for (const child of other.childManifests ?? []) rememberChild(tab, item, child);
      }
      item.variants = mergeVariants(tab, item.variants, other.variants);
      mergeReferences(tab, item, other);
      mergeSegmentPatterns(tab, item, other.segmentPatterns);
      item.protected = item.protected || other.protected === true; item.live = mergeLive(item.live, other.live);
      if (item.duration === undefined && other.duration !== undefined) item.duration = other.duration;
      delete tab.media[other.id]; grouped = true;
    }
  } while (grouped);
  // A master alone has no EXTINF duration. Inspect one representative media playlist,
  // including misleading image-suffixed URIs, without downloading segments or every quality.
  if (!target.child && info.type === 'hls' && info.duration === undefined) {
    const preferred = info.variants.filter(variant => variant.url && variant.kind !== 'subtitles')
      .sort((a, b) => Number(b.kind === 'video') - Number(a.kind === 'video') ||
        (b.height ?? 0) - (a.height ?? 0) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];
    if (preferred?.url && item.childUrls.includes(preferred.url)) rememberChild(tab, item, {
      url: preferred.url, instance: s.revision + 1, status: 'observed', frameIds: [...item.frameIds],
    });
  }
  item.status = item.protected ? 'unsupported' : 'confirmed';
  item.reason = item.protected ? 'protected-manifest' : info.truncated ? `variant-limit:${info.truncated}` : undefined;
  if (info.truncated) {
    dropped(tab, info.truncated, 'variant-limit');
  }
  return replace(s, tab);
}
export function probeFailed(s: Snapshot, job: ProbeJob, reason: string): Snapshot {
  const target = resolveProbeJob(s, job); if (!target) return s;
  const tab = structuredClone(target.tab);
  const item = tab.media[target.item.id];
  if (target.child) {
    Object.assign(item.childManifests!.find(child => child.url === job.url)!, { status: 'unresolved', reason: reason.slice(0, 1000) });
    tab.errors = unique(tab.errors, [`child-manifest:${reason}:${job.url}`.slice(0, 1000)]);
  } else Object.assign(item, { status: 'unresolved', reason: reason.slice(0, 1000) });
  return replace(s, tab);
}
export function probeStarted(s: Snapshot, job: ProbeJob): Snapshot {
  const target = resolveProbeJob(s, job); if (!target) return s;
  const tab = structuredClone(target.tab);
  const item = tab.media[target.item.id];
  const work = target.child ? item.childManifests!.find(child => child.url === job.url)! : item;
  work.status = 'probing';
  work.probeAttempts = Math.min(MAX_PROBE_ATTEMPTS, (work.probeAttempts ?? 0) + 1);
  return replace(s, tab);
}
