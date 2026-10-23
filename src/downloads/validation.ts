import type { Snapshot, Variant } from '../core/model.ts';
import { normalizeUrl } from '../core/identity.ts';
import type { DownloadSelection, DownloadStartRequest } from './model.ts';

export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const natural = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const text = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
export const httpUrl = (value: unknown): value is string =>
  text(value, 16_384) && normalizeUrl(value) === value;
export const onlyKeys = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).every(key => keys.includes(key));
const optional = (value: unknown, valid: (value: unknown) => boolean) => value === undefined || valid(value);
const dimension = (value: unknown) => natural(value) && value > 0 && value <= 65_535;

/** Produce one safe filesystem leaf; never accept a path supplied by a popup. */
export function safeFilename(value: string): string {
  let stem = value.replace(/\.[a-z0-9]{1,8}$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/^[. ]+|[. ]+$/g, '').slice(0, 180).replace(/[. ]+$/g, '');
  if (!stem) stem = 'video';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = `_${stem}`;
  return `${stem}.mp4`;
}

export function validSelection(value: unknown): value is DownloadSelection {
  return record(value) && onlyKeys(value, ['tabId', 'epoch', 'mediaId', 'instance', 'pageUrl', 'frameId', 'documentId',
    'sourceUrl', 'videoUrl', 'audioUrl', 'requestedVariantId', 'width', 'height', 'filename', 'output']) &&
    natural(value.tabId) && natural(value.epoch) && text(value.mediaId, 16_384) && natural(value.instance) &&
    httpUrl(value.pageUrl) && natural(value.frameId) && text(value.documentId, 1024) && httpUrl(value.sourceUrl) &&
    httpUrl(value.videoUrl) && optional(value.audioUrl, httpUrl) && optional(value.requestedVariantId, value => text(value, 128)) && optional(value.width, dimension) &&
    optional(value.height, dimension) && text(value.filename, 255) && safeFilename(value.filename) === value.filename && value.output === 'mp4';
}

/** Bind a popup request to the currently confirmed detector source and live document. */
export function selectDownload(snapshot: Snapshot, request: DownloadStartRequest): DownloadSelection {
  if (!record(request) || !onlyKeys(request, ['requestId', 'tabId', 'epoch', 'mediaId', 'instance', 'variantId', 'filename']) ||
      !text(request.requestId, 128) || !natural(request.tabId) || !natural(request.epoch) || !text(request.mediaId, 16_384) ||
      !natural(request.instance) || !optional(request.variantId, value => text(value, 128)) ||
      !optional(request.filename, value => text(value, 255))) throw new Error('Invalid download request');
  const tab = snapshot.tabs[request.tabId];
  const item = tab?.media[request.mediaId];
  if (!tab || tab.id !== request.tabId || tab.epoch !== request.epoch || !item || item.id !== request.mediaId ||
      (item.instance ?? 0) !== request.instance) throw new Error('Stale download request');
  const frameId = item.frameIds.find(frame => natural(frame) && text(tab.documents[frame], 1024) && item.documentIds.includes(tab.documents[frame]));
  if (frameId === undefined) throw new Error('Stale download document');
  if (item.type !== 'hls' || item.status !== 'confirmed' || item.protected !== false || item.live === true ||
      !httpUrl(item.url) || !httpUrl(tab.url)) throw new Error('Source is not eligible for download');
  let variant: Variant | undefined;
  if (request.variantId !== undefined) {
    variant = item.variants.find(v => v.id === request.variantId);
    if (!variant || variant.kind !== 'video' || !httpUrl(variant.url)) throw new Error('Invalid download rendition');
  } else {
    variant = item.variants.filter(v => v.kind === 'video' && httpUrl(v.url))
      .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];
    if (item.variants.length && !variant) throw new Error('Missing video rendition');
  }
  const group = variant?.audioGroup ?? variant?.group;
  const audio = group ? item.variants.find(v => v.kind === 'audio' && v.group === group && httpUrl(v.url)) : undefined;
  const selection: DownloadSelection = {
    tabId: tab.id, epoch: tab.epoch, mediaId: item.id, instance: request.instance,
    pageUrl: tab.url, frameId, documentId: tab.documents[frameId], sourceUrl: item.url,
    videoUrl: variant?.url ?? item.url, filename: safeFilename(request.filename ?? item.title?.slice(0, 255) ?? 'video.mp4'), output: 'mp4',
    ...(request.variantId !== undefined ? { requestedVariantId: request.variantId } : {}),
    ...(audio?.url ? { audioUrl: audio.url } : {}),
    ...(variant?.width !== undefined ? { width: variant.width } : {}),
    ...(variant?.height !== undefined ? { height: variant.height } : {}),
  };
  if (!validSelection(selection)) throw new Error('Invalid download source metadata');
  return selection;
}
