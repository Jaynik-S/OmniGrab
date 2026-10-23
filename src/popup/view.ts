import type { MediaItem, TabState, Variant } from '../core/model.ts';
import { downloadView } from './download-view.ts';
import type { DownloadViewOptions } from './download-view.ts';
export interface SnapshotResponse { tab?: TabState; revision: number; error?: string; }

function node(document: Document, tag: string, text?: string, className?: string): HTMLElement {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function durationText(seconds: number): string | undefined {
  if (!Number.isFinite(seconds) || seconds < 0) return;
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  const remaining = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${remaining}` : `${minutes}:${remaining}`;
}

function metadata(item: MediaItem): string {
  return [
    item.width && item.height ? `${item.width} × ${item.height}` : undefined,
    item.duration !== undefined ? durationText(item.duration) : undefined,
    item.type === 'direct' && item.bytes !== undefined ? `${item.bytes.toLocaleString()} bytes` : undefined,
    item.live === true ? 'Live' : item.live === false ? 'VOD' : undefined,
    item.protected ? 'Protection signaled' : undefined,
  ].filter(Boolean).join(' · ');
}

function confirmedRemote(item: MediaItem): boolean {
  return item.status === 'confirmed' && ['direct', 'hls', 'dash'].includes(item.type) && /^https?:\/\//i.test(item.url);
}

function variantText(variant: Variant): string {
  return [variant.kind, variant.width && variant.height ? `${variant.width} × ${variant.height}` : variant.height ? `${variant.height}p` : undefined,
    variant.bandwidth ? `${variant.bandwidth.toLocaleString()} bit/s` : undefined, variant.codecs, variant.language,
    variant.url ?? variant.representationId ?? variant.id].filter(Boolean).join(' · ');
}

function renderItem(document: Document, item: MediaItem, title: string | undefined, copy: (url: string) => void, controls?: HTMLElement): HTMLElement {
  const article = node(document, 'article', undefined, 'media');
  article.dataset.sourceKey = item.id;
  const heading = node(document, 'div', undefined, 'row');
  const protocol = item.type === 'hls' || item.type === 'dash' ? item.type.toUpperCase() : item.type === 'blob' ? 'Local blob' : item.type;
  heading.append(node(document, 'h3', item.title || title || 'Media source'), node(document, 'span', `${protocol} · ${item.status}`, 'status'));
  article.append(heading, node(document, 'p', `Source protocol: ${protocol}`, 'muted'));
  const details = metadata(item);
  if (details) article.append(node(document, 'p', details));
  const qualities = [...new Set(item.variants.filter(variant => variant.kind !== 'audio' && variant.kind !== 'subtitles')
    .map(variant => variant.height).filter((height): height is number => height !== undefined && Number.isFinite(height) && height > 0))]
    .sort((a, b) => b - a);
  if (qualities.length) article.append(node(document, 'p', `Qualities: ${qualities.map(height => `${height}p`).join(' · ')}`, 'qualities'));
  if (item.reason) article.append(node(document, 'p', item.reason, 'error'));

  if (controls) article.append(controls);
  const source = node(document, 'details', undefined, 'source-details');
  source.append(node(document, 'summary', 'Source details'), node(document, 'p', item.url, 'url'));
  if (item.mime) source.append(node(document, 'p', `Response MIME: ${item.mime}`, 'muted'));
  if (item.bytes !== undefined) source.append(node(document, 'p', `Observed response bytes: ${item.bytes.toLocaleString()}`, 'muted'));
  const copyButton = node(document, 'button', 'Copy URL') as HTMLButtonElement;
  copyButton.type = 'button';
  copyButton.setAttribute('aria-label', `Copy URL for ${item.type} source`);
  copyButton.addEventListener('click', () => copy(item.url));
  source.append(copyButton, node(document, 'p', `Methods: ${item.methods.join(', ')} · Frames: ${item.frameIds.join(', ')}`, 'muted'));
  if (item.documentIds.length) source.append(node(document, 'p', `Documents: ${item.documentIds.join(', ')}`, 'muted'));
  if (item.elementIds.length) source.append(node(document, 'p', `Elements: ${item.elementIds.join(', ')}`, 'muted'));
  source.append(node(document, 'p', `First seen ${new Date(item.firstSeen).toLocaleTimeString()} · Last seen ${new Date(item.lastSeen).toLocaleTimeString()}`, 'muted'));
  if (item.variants.length) {
    const variants = node(document, 'details');
    variants.append(node(document, 'summary', `${item.variants.length} variants`));
    const list = node(document, 'ul');
    for (const variant of item.variants) list.append(node(document, 'li', variantText(variant)));
    variants.append(list);
    source.append(variants);
  }
  article.append(source);
  return article;
}

export function renderSnapshot(target: HTMLElement, response: SnapshotResponse, copy: (url: string) => void, downloads?: DownloadViewOptions): void {
  const document = target.ownerDocument;
  const tab = response.tab;
  const focus = document.activeElement as HTMLInputElement | null;
  const control = focus?.dataset?.control;
  const selection = focus?.tagName === 'INPUT' ? [focus.selectionStart, focus.selectionEnd, focus.selectionDirection] as const : undefined;
  const scrollTop = document.documentElement.scrollTop;
  const opened = [...target.querySelectorAll<HTMLElement>('details[open]')].map(detail => detail.dataset.detailsKey).filter(Boolean);
  const view = downloads ? downloadView(target, downloads, () => renderSnapshot(target, response, copy, downloads)) : undefined;
  target.replaceChildren();
  if (response.error) target.append(node(document, 'p', response.error, 'error'));
  const context = node(document, 'section', undefined, 'context');
  context.append(node(document, 'h2', tab?.title || 'Active tab'));
  if (tab?.url) context.append(node(document, 'p', tab.url, 'url'));
  context.append(node(document, 'p', `Revision ${response.revision}${tab ? ` · Tab ${tab.id} · Generation ${tab.epoch}` : ''}`, 'muted'));
  target.append(context);
  const items = Object.values(tab?.media ?? {}).sort((a, b) => b.lastSeen - a.lastSeen);
  const primary = items.filter(confirmedRemote);
  const secondary = items.filter(item => !confirmedRemote(item));
  if (!items.length) {
    target.append(node(document, 'p', 'No media observed. Rescan after a player appears or starts loading.', 'empty'));
  } else if (!primary.length) {
    target.append(node(document, 'p', 'No confirmed remote source yet. Inspect the evidence below or rescan after playback starts.', 'empty'));
  }
  if (primary.length) {
    const section = node(document, 'section', undefined, 'primary-media');
    section.setAttribute('aria-label', 'Confirmed remote media');
    section.append(node(document, 'h2', 'Confirmed media'));
    for (const item of primary) section.append(renderItem(document, item, tab?.title, copy, tab && view?.source(item, tab)));
    target.append(section);
  }
  if (secondary.length) {
    const evidence = node(document, 'details', undefined, 'secondary-evidence');
    evidence.append(node(document, 'summary', `Local and unconfirmed evidence (${secondary.length})`));
    // A failed manifest is the main outcome until a remote source is confirmed.
    if (!primary.length && secondary.some(item => (item.type === 'hls' || item.type === 'dash') && item.status === 'unresolved')) evidence.setAttribute('open', '');
    for (const item of secondary) evidence.append(renderItem(document, item, tab?.title, copy, tab && view?.source(item, tab)));
    target.append(evidence);
  }
  if (view) target.append(view.jobs(tab));
  const diagnostics = node(document, 'details', undefined, 'diagnostics');
  diagnostics.append(node(document, 'summary', 'Diagnostics'));
  diagnostics.append(node(document, 'p', `${items.length} sources · ${tab?.dropped ?? 0} observations/items dropped by retention limits`));
  for (const error of tab?.errors ?? []) diagnostics.append(node(document, 'p', error, 'error'));
  if (!tab?.errors.length) diagnostics.append(node(document, 'p', 'No recorded errors. Browser permissions, closed shadow roots and unexposed media buffers may limit discovery.', 'muted'));
  target.append(diagnostics);
  for (const [index, detail] of [...target.querySelectorAll('details')].entries()) {
    detail.dataset.detailsKey = `${detail.closest<HTMLElement>('.media')?.dataset.sourceKey ?? ''}:${detail.className || detail.querySelector('summary')?.textContent || index}`;
    if (opened.includes(detail.dataset.detailsKey)) detail.open = true;
  }
  if (control) {
    const replacement = [...target.querySelectorAll<HTMLElement>('[data-control]')].find(value => value.dataset.control === control);
    replacement?.focus({ preventScroll: true });
    if (selection && replacement?.tagName === 'INPUT' && selection[0] !== null) {
      (replacement as HTMLInputElement).setSelectionRange(selection[0], selection[1], selection[2] ?? undefined);
    }
  }
  document.documentElement.scrollTop = scrollTop;
}
