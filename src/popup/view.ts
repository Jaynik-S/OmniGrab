import type { MediaItem, TabState, Variant } from '../core/model.ts';
export interface SnapshotResponse { tab?: TabState; revision: number; error?: string; }

function node(document: Document, tag: string, text?: string, className?: string): HTMLElement {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function metadata(item: MediaItem): string {
  return [
    item.width && item.height ? `${item.width} × ${item.height}` : undefined,
    item.duration !== undefined ? `${Number(item.duration.toFixed(2))} s` : undefined,
    item.bytes !== undefined ? `${item.bytes.toLocaleString()} bytes` : undefined,
    item.mime, item.live === true ? 'Live' : item.live === false ? 'VOD' : undefined,
    item.protected ? 'Protection signaled' : undefined,
  ].filter(Boolean).join(' · ');
}

function variantText(variant: Variant): string {
  return [variant.kind, variant.width && variant.height ? `${variant.width} × ${variant.height}` : variant.height ? `${variant.height}p` : undefined,
    variant.bandwidth ? `${variant.bandwidth.toLocaleString()} bit/s` : undefined, variant.codecs, variant.language,
    variant.url ?? variant.representationId ?? variant.id].filter(Boolean).join(' · ');
}

export function renderSnapshot(target: HTMLElement, response: SnapshotResponse, copy: (url: string) => void): void {
  const document = target.ownerDocument;
  const tab = response.tab;
  target.replaceChildren();
  if (response.error) target.append(node(document, 'p', response.error, 'error'));
  const context = node(document, 'section', undefined, 'context');
  context.append(node(document, 'h2', tab?.title || 'Active tab'));
  if (tab?.url) context.append(node(document, 'p', tab.url, 'url'));
  context.append(node(document, 'p', `Revision ${response.revision}${tab ? ` · Tab ${tab.id} · Generation ${tab.epoch}` : ''}`, 'muted'));
  target.append(context);
  const items = Object.values(tab?.media ?? {}).sort((a, b) => b.lastSeen - a.lastSeen);
  if (!items.length) {
    target.append(node(document, 'p', 'No media observed. Rescan after a player appears or starts loading.', 'empty'));
  }
  for (const item of items) {
    const article = node(document, 'article', undefined, 'media');
    const heading = node(document, 'div', undefined, 'row');
    heading.append(node(document, 'h3', item.title || 'Media source'), node(document, 'span', `${item.type} · ${item.status}`, 'status'));
    article.append(heading, node(document, 'p', item.url, 'url'));
    const copyButton = node(document, 'button', 'Copy URL') as HTMLButtonElement;
    copyButton.type = 'button';
    copyButton.setAttribute('aria-label', `Copy URL for ${item.type} source`);
    copyButton.addEventListener('click', () => copy(item.url));
    article.append(copyButton, node(document, 'p', `Methods: ${item.methods.join(', ')} · Frames: ${item.frameIds.join(', ')}`, 'muted'));
    const details = metadata(item);
    if (details) article.append(node(document, 'p', details));
    if (item.reason) article.append(node(document, 'p', item.reason, 'error'));
    article.append(node(document, 'p', `First seen ${new Date(item.firstSeen).toLocaleTimeString()} · Last seen ${new Date(item.lastSeen).toLocaleTimeString()}`, 'muted'));
    if (item.variants.length) {
      const variants = node(document, 'details');
      variants.append(node(document, 'summary', `${item.variants.length} variants`));
      const list = node(document, 'ul');
      for (const variant of item.variants) list.append(node(document, 'li', variantText(variant)));
      variants.append(list);
      article.append(variants);
    }
    target.append(article);
  }
  const diagnostics = node(document, 'details', undefined, 'diagnostics');
  diagnostics.append(node(document, 'summary', 'Diagnostics'));
  diagnostics.append(node(document, 'p', `${items.length} sources · ${tab?.dropped ?? 0} observations/items dropped by retention limits`));
  for (const error of tab?.errors ?? []) diagnostics.append(node(document, 'p', error, 'error'));
  if (!tab?.errors.length) diagnostics.append(node(document, 'p', 'No recorded errors. Browser permissions, closed shadow roots and unexposed media buffers may limit discovery.', 'muted'));
  target.append(diagnostics);
}
