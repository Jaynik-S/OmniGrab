import { parseHls } from '../manifests/hls.ts';
import { checkText, resolveHttp } from '../manifests/shared.ts';
import { MAX_REFERENCE_CHARS } from '../core/limits.ts';
import type { ByteRange, ResourceGrant } from './model.ts';

interface HlsVideo { url: string; originalUrl: string; bandwidth: number; width?: number; height?: number; audioGroup?: string; }
interface HlsAudio { url?: string; group: string; default: boolean; }
export interface HlsDownloadPlaylist {
  text: string; master: boolean; videos: HlsVideo[]; audio: HlsAudio[];
  resources: ResourceGrant[]; duration?: number;
}

function attributes(value: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  let remaining = value.trim();
  while (remaining) {
    const match = /^([A-Z0-9-]+)=(?:"([^"\r\n]*)"|([^,\s"]+))(?:,|$)/.exec(remaining);
    if (!match || result[match[1]] !== undefined) throw new Error('Unsupported HLS attributes');
    result[match[1]] = match[2] ?? match[3];
    remaining = remaining.slice(match[0].length).trim();
  }
  return result;
}

function byteRange(value: string, previous: ResourceGrant | undefined, url: string): ByteRange {
  const match = /^(\d+)(?:@(\d+))?$/.exec(value);
  if (!match) throw new Error('Unsupported HLS byte range');
  const length = Number(match[1]);
  const start = match[2] === undefined ? previous?.url === url && previous.range ? previous.range.end + 1 : NaN : Number(match[2]);
  const end = start + length - 1;
  if (!Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end))
    throw new Error('Unsupported HLS byte range');
  return { start, end };
}

const supported = new Set(['#EXTM3U', '#EXT-X-VERSION', '#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-STREAM-INF',
  '#EXT-X-I-FRAME-STREAM-INF', '#EXT-X-MEDIA', '#EXT-X-TARGETDURATION', '#EXT-X-MEDIA-SEQUENCE',
  '#EXT-X-DISCONTINUITY-SEQUENCE', '#EXTINF', '#EXT-X-BYTERANGE', '#EXT-X-MAP', '#EXT-X-DISCONTINUITY',
  '#EXT-X-ENDLIST', '#EXT-X-PLAYLIST-TYPE', '#EXT-X-PROGRAM-DATE-TIME']);

/** Stricter download-only interpretation; the discovery parser remains unchanged. */
export function parseDownloadHls(text: string, requestedUrl: string, finalUrl: string): HlsDownloadPlaylist {
  const info = parseHls(text, finalUrl);
  if (info.protected) throw new Error('Protected HLS is unsupported');
  const result: HlsDownloadPlaylist = { text: '', master: false, videos: [], audio: [], resources: [] };
  const normalized: string[] = [];
  let stream: Record<string, string> | undefined;
  let range: string | undefined;
  let previous: ResourceGrant | undefined;
  let segments = 0;
  let ended = false;
  let totalReferences = 0;
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { normalized.push(line); continue; }
    if (!line.startsWith('#')) {
      if (ended) throw new Error('Unsupported media after HLS end');
      const url = resolveHttp(line, finalUrl);
      if (stream) {
        const dimensions = stream.RESOLUTION?.split('x').map(Number);
        const audioOnly = !dimensions && stream.CODECS?.split(',').every(codec => /^(?:mp4a|ac-3|ec-3|opus|flac|alac)(?:\.|$)/i.test(codec.trim()));
        if (!audioOnly) result.videos.push({ url, originalUrl: resolveHttp(line, requestedUrl), bandwidth: Number(stream.BANDWIDTH),
          width: dimensions?.[0], height: dimensions?.[1], audioGroup: stream.AUDIO });
        stream = undefined;
      } else {
        const grant: ResourceGrant = { url, ...(range !== undefined ? { range: byteRange(range, previous, url) } : {}) };
        result.resources.push(grant); previous = grant; range = undefined; segments++;
      }
      normalized.push(url); totalReferences += url.length;
      continue;
    }
    if (ended && line.startsWith('#EXT')) throw new Error('Unsupported HLS metadata after end');
    const colon = line.indexOf(':');
    const tag = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1);
    if (tag.startsWith('#EXT') && !supported.has(tag)) throw new Error('Unsupported HLS download construct');
    let normalizedLine = line;
    if (tag === '#EXT-X-STREAM-INF') { result.master = true; stream = attributes(value); }
    if (tag === '#EXT-X-MEDIA' || tag === '#EXT-X-I-FRAME-STREAM-INF' || tag === '#EXT-X-MAP') {
      const attrs = attributes(value);
      if (attrs.URI) {
        const url = resolveHttp(attrs.URI, finalUrl); totalReferences += url.length;
        normalizedLine = `${tag}:${value.replace(/(^|,)\s*URI=(?:"[^"\r\n]*"|[^,\s"]+)/, (_match, comma: string) => `${comma}URI="${url}"`)}`;
      }
      if (tag !== '#EXT-X-MAP') result.master = true;
      if (tag === '#EXT-X-MEDIA' && attrs.TYPE === 'AUDIO') {
        if (attrs.DEFAULT && !['YES', 'NO'].includes(attrs.DEFAULT)) throw new Error('Unsupported HLS audio default');
        result.audio.push({ group: attrs['GROUP-ID'], default: attrs.DEFAULT === 'YES', url: attrs.URI ? resolveHttp(attrs.URI, finalUrl) : undefined });
      }
      if (tag === '#EXT-X-MAP') {
        if (!attrs.URI) throw new Error('Unsupported HLS map');
        const url = resolveHttp(attrs.URI, finalUrl);
        result.resources.push({ url, ...(attrs.BYTERANGE !== undefined ? { range: byteRange(attrs.BYTERANGE, undefined, url) } : {}) });
      }
    }
    if (['#EXT-X-VERSION', '#EXT-X-DISCONTINUITY-SEQUENCE'].includes(tag) &&
        (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) throw new Error('Unsupported HLS sequence or version');
    if (tag === '#EXT-X-BYTERANGE') {
      if (range !== undefined) throw new Error('Unsupported duplicate HLS byte range');
      range = value;
    }
    if (tag === '#EXT-X-ENDLIST') ended = true;
    normalized.push(normalizedLine);
  }
  if (totalReferences > MAX_REFERENCE_CHARS || result.resources.length > 10_000 || result.videos.length + result.audio.length > 10_000)
    throw new Error('Unsupported HLS reference limit');
  if (!result.master && (!ended || !segments || range !== undefined || !info.duration || !Number.isFinite(info.duration)))
    throw new Error('A complete HLS media playlist is required');
  result.text = normalized.join('\n');
  checkText(result.text);
  if (!result.master) result.duration = info.duration;
  return result;
}
