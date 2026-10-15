import type { Observation } from '../core/model.ts';

export type CollectedObservation = Omit<Observation, 'tabId' | 'frameId' | 'documentId' | 'epoch' | 'observedAt'>;
export interface ResourceEntry { name: string; initiatorType: string; }

const MAX_OBSERVATIONS = 400;
const MAX_NODES = 20_000;
const ids = new WeakMap<Element, string>();
let nextId = 0;

function sourceUrl(raw: string | null | undefined, base: string, allowBlob = true): string | undefined {
  if (!raw?.trim() || raw.length > 16_384) return;
  try {
    const url = new URL(raw, base);
    if (url.protocol === 'http:' || url.protocol === 'https:' || (allowBlob && url.protocol === 'blob:')) return url.href;
  } catch { /* Invalid page claims are not observations. */ }
}

function baseUrl(document: Document, pageUrl: string): string {
  return sourceUrl(document.querySelector('base[href]')?.getAttribute('href'), pageUrl, false) ?? pageUrl;
}

function currentPageUrl(document: Document, fallback: string): string {
  return sourceUrl(document.URL, fallback, false) ?? sourceUrl(document.location?.href, fallback, false) ?? fallback;
}

function finite(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

// Traverse only accessible DOM. No access to parent frames or closed shadow roots.
function scan(root: Node, document: Document, pageUrl: string, visitShadow?: (root: ShadowRoot) => void): CollectedObservation[] {
  pageUrl = currentPageUrl(document, pageUrl);
  const pending: Node[] = [root];
  const observations: CollectedObservation[] = [];
  const base = baseUrl(document, pageUrl);
  let visited = 0;
  while (pending.length && visited++ < MAX_NODES && observations.length < MAX_OBSERVATIONS) {
    const node = pending.pop()!;
    if (node.nodeType === 1) {
      const element = node as Element;
      if (element.localName === 'video' || element.localName === 'audio') {
        observations.push(...mediaSources(element as HTMLMediaElement, document, pageUrl, base).slice(0, MAX_OBSERVATIONS - observations.length));
      }
      if (element.shadowRoot) {
        visitShadow?.(element.shadowRoot);
        pending.push(element.shadowRoot);
      }
    }
    // Bound the traversal stack as well as the number of visited nodes.
    for (let child = node.lastChild; child && pending.length < MAX_NODES; child = child.previousSibling) {
      if (child.nodeType === 1) pending.push(child);
    }
  }
  return observations;
}

function mediaSources(media: HTMLMediaElement, document: Document, pageUrl: string, base: string): CollectedObservation[] {
  let elementId = ids.get(media);
  if (!elementId) { elementId = `media-${++nextId}`; ids.set(media, elementId); }
  const current = sourceUrl(media.currentSrc, base) ?? sourceUrl(media.getAttribute('src'), base);
  const video = media as HTMLVideoElement;
  const shared = {
    method: 'dom' as const, elementId, pageUrl, title: document.title.slice(0, 512),
    poster: sourceUrl(media.getAttribute('poster'), base, false),
  };
  const found = new Map<string, CollectedObservation>();
  const add = (raw: string | null | undefined, mime?: string | null) => {
    const url = sourceUrl(raw, base);
    if (!url) return;
    const previous = found.get(url);
    found.set(url, {
      ...shared, ...previous, url, role: url === current ? 'current' : 'alternative',
      ...(url === current ? { width: finite(video.videoWidth) || undefined, height: finite(video.videoHeight) || undefined, duration: finite(media.duration) } : {}),
      ...(mime ? { mime: mime.slice(0, 256) } : {}),
    });
  };
  add(current);
  add(media.getAttribute('src'));
  let inspected = 0;
  for (let child = media.firstElementChild; child && inspected++ < MAX_NODES; child = child.nextElementSibling) {
    if (found.size >= MAX_OBSERVATIONS) break;
    if (child.localName === 'source') add(child.getAttribute('src'), child.getAttribute('type'));
  }
  return [...found.values()];
}

export function collectMedia(document: Document, pageUrl: string): CollectedObservation[] {
  return scan(document, document, pageUrl);
}

export function collectResources(entries: Iterable<ResourceEntry>, pageUrl: string): CollectedObservation[] {
  const found = new Map<string, CollectedObservation>();
  let visited = 0;
  for (const entry of entries) {
    if (visited++ >= 5_000 || found.size >= 200) break;
    const url = sourceUrl(entry.name, pageUrl, false);
    if (!url) continue;
    const pathname = new URL(url).pathname;
    if (/\.(?:m4s|ts|vtt|srt|key)$/i.test(pathname)) continue;
    if (!/\.(?:mp4|m4v|mov|webm|ogv|ogg|mp3|m4a|aac|wav|flac|m3u8|mpd)$/i.test(pathname)
      && entry.initiatorType !== 'video' && entry.initiatorType !== 'audio') continue;
    found.set(url, { url, method: 'resource', pageUrl });
  }
  return [...found.values()];
}

export interface MediaObserverOptions {
  delay?: number;
  /** Visible-document discovery interval for roots attached without a DOM mutation. */
  sweepInterval?: number;
}

export function observeMedia(document: Document, pageUrl: string, report: (batch: CollectedObservation[]) => void, options: MediaObserverOptions = {}) {
  const Mutation = document.defaultView?.MutationObserver;
  const roots = new Set<Node>();
  const observed = new Set<Node>();
  const recent = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const emit = (batch: CollectedObservation[]) => {
    const changed = batch.filter(item => {
      const key = `${item.elementId}:${item.url}`;
      const value = JSON.stringify(item);
      if (recent.get(key) === value) return false;
      recent.delete(key);
      recent.set(key, value);
      if (recent.size > 1_000) recent.delete(recent.keys().next().value!);
      return true;
    });
    for (let index = 0; index < changed.length; index += 100) report(changed.slice(index, index + 100));
  };
  const flush = () => {
    timer = undefined;
    prune();
    const work = [...roots];
    roots.clear();
    for (const root of work) {
      if (root === document || root.isConnected) emit(scan(root, document, pageUrl, watch));
    }
  };
  const schedule = (root: Node) => {
    if (stopped) return;
    // Excessive mutation storms collapse to one bounded rescan.
    if (roots.size >= 100) { roots.clear(); roots.add(document); }
    else if (!roots.has(document)) roots.add(root);
    timer ??= setTimeout(flush, options.delay ?? 75);
  };
  const onEvent = (event: Event) => {
    const target = event.target as Element | null;
    if (target?.nodeType === 1) schedule(target);
  };
  const observer = Mutation ? new Mutation(records => {
    prune();
    for (const record of records) {
      if (record.type === 'attributes') {
        const target = record.target as Element;
        schedule(target.localName === 'source' ? target.parentNode ?? target : target);
      } else {
        // Source insertion/removal also refreshes the owning media element.
        if ((record.target as Element).localName === 'video' || (record.target as Element).localName === 'audio') schedule(record.target);
        for (const node of record.addedNodes) if (node.nodeType === 1) schedule(node);
      }
    }
  }) : undefined;
  const events = ['loadstart', 'loadedmetadata', 'durationchange', 'emptied', 'loadeddata'];
  const mutationOptions = { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'type', 'poster'] };
  function prune() {
    let removed = false;
    for (const root of observed) {
      if (root === document || (root as ShadowRoot).host?.isConnected) continue;
      for (const event of events) root.removeEventListener(event, onEvent, true);
      observed.delete(root);
      roots.delete(root);
      removed = true;
    }
    if (removed) {
      // MutationObserver has no unobserve; reconnect only roots that remain alive.
      observer?.disconnect();
      for (const root of observed) observer?.observe(root, mutationOptions);
    }
  }
  function watch(root: Node) {
    prune();
    if (observed.has(root) || observed.size >= 200) return;
    observed.add(root);
    observer?.observe(root, mutationOptions);
    for (const event of events) root.addEventListener(event, onEvent, true);
  }
  watch(document);
  emit(scan(document, document, pageUrl, watch));
  const visible = () => document.visibilityState !== 'hidden';
  // attachShadow on an already connected host is invisible to document MutationObserver.
  const sweep = setInterval(() => {
    if (visible()) schedule(document);
  }, Math.max(20, options.sweepInterval ?? 2_000));
  const onVisibility = () => { if (visible()) schedule(document); };
  document.addEventListener('visibilitychange', onVisibility);
  return {
    rescan() { recent.clear(); schedule(document); },
    disconnect() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      clearInterval(sweep);
      document.removeEventListener('visibilitychange', onVisibility);
      observer?.disconnect();
      for (const root of observed) for (const event of events) root.removeEventListener(event, onEvent, true);
      observed.clear(); roots.clear(); recent.clear();
    },
  };
}
