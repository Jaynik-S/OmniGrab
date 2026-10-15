import type { ManifestInfo, Variant } from '../core/model.ts';
import { addReference, addVariant, checkText, positiveNumber, resolveHttp, uniqueReferences } from './shared.ts';

/** Attribute lists contain quoted commas (notably CODECS and rendition names). */
function attributes(value: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  let rest = value.trim();
  while (rest) {
    const match = /^([A-Z0-9-]+)=(?:"([^"\r\n]*)"|([^,\s"]+))(?:,|$)/.exec(rest);
    if (!match || result[match[1]] !== undefined) throw new Error('Malformed HLS attribute list');
    result[match[1]] = match[2] ?? match[3];
    rest = rest.slice(match[0].length).trim();
    if (!rest && match[0].endsWith(',')) throw new Error('Malformed HLS trailing attribute comma');
  }
  return result;
}

function streamVariant(attrs: Record<string, string>, url: string, index: number): Variant {
  const dimensions = attrs.RESOLUTION ? /^(\d+)x(\d+)$/.exec(attrs.RESOLUTION) : undefined;
  if (attrs.RESOLUTION && !dimensions) throw new Error('Invalid HLS resolution');
  if (!attrs.BANDWIDTH) throw new Error('Missing HLS stream bandwidth');
  const audioOnly = !dimensions && attrs.CODECS?.split(',').every(codec => /^(?:mp4a|ac-3|ec-3|opus|flac|alac)(?:\.|$)/i.test(codec.trim()));
  return {
    id: `hls:${index}`, url, kind: audioOnly ? 'audio' : 'video',
    bandwidth: positiveNumber(attrs.BANDWIDTH, 'HLS bandwidth'),
    width: positiveNumber(dimensions?.[1], 'HLS width'),
    height: positiveNumber(dimensions?.[2], 'HLS height'),
    codecs: attrs.CODECS, group: attrs.AUDIO, audioGroup: attrs.AUDIO, subtitleGroup: attrs.SUBTITLES,
  };
}

export function parseHls(text: string, baseUrl: string): ManifestInfo {
  checkText(text);
  resolveHttp(baseUrl, baseUrl);
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim());
  if (lines.shift() !== '#EXTM3U') throw new Error('Missing HLS EXTM3U header');
  const info: ManifestInfo = { type: 'hls', variants: [], childUrls: [], segmentUrls: [], live: true, protected: false };
  let stream: Record<string, string> | undefined;
  let segmentDuration: number | undefined;
  let duration = 0;
  let media = false;
  let master = false;
  for (const line of lines) {
    if (!line) continue;
    if (!line.startsWith('#')) {
      const url = resolveHttp(line, baseUrl);
      if (stream) {
        addVariant(info, streamVariant(stream, url, info.variants.length));
        stream = undefined;
      } else if (segmentDuration !== undefined) {
        addReference(info.segmentUrls, url);
        duration += segmentDuration;
        if (!Number.isFinite(duration)) throw new Error('Invalid HLS total duration');
        segmentDuration = undefined;
      } else throw new Error('HLS URI without stream or segment descriptor');
      continue;
    }
    const colon = line.indexOf(':');
    const tag = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1);
    if (tag === '#EXT-X-STREAM-INF') {
      if (stream || segmentDuration !== undefined) throw new Error('Missing HLS URI');
      stream = attributes(value);
      master = true;
    } else if (tag === '#EXT-X-MEDIA') {
      master = true;
      const attrs = attributes(value);
      if (!attrs.TYPE || !attrs['GROUP-ID'] || !attrs.NAME) throw new Error('Missing HLS rendition attributes');
      const kind = attrs.TYPE === 'AUDIO' ? 'audio' : attrs.TYPE === 'SUBTITLES' ? 'subtitles' : undefined;
      if (kind) {
        if (kind === 'subtitles' && !attrs.URI) throw new Error('Missing HLS subtitle URI');
        addVariant(info, { id: `hls:${info.variants.length}`, kind, group: attrs['GROUP-ID'], language: attrs.LANGUAGE, url: attrs.URI ? resolveHttp(attrs.URI, baseUrl) : undefined });
      }
    } else if (tag === '#EXT-X-I-FRAME-STREAM-INF') {
      master = true;
      const attrs = attributes(value);
      if (!attrs.URI) throw new Error('Missing HLS I-frame URI');
      addVariant(info, streamVariant(attrs, resolveHttp(attrs.URI, baseUrl), info.variants.length));
    } else if (tag === '#EXTINF') {
      if (stream || segmentDuration !== undefined) throw new Error('Missing HLS URI');
      const raw = value.split(',')[0];
      segmentDuration = Number(raw);
      if (!/^\d+(?:\.\d+)?$/.test(raw) || !Number.isFinite(segmentDuration)) throw new Error('Invalid HLS segment duration');
      media = true;
    } else if (tag === '#EXT-X-MAP' || tag === '#EXT-X-PART') {
      media = true;
      const attrs = attributes(value);
      if (!attrs.URI) throw new Error('Missing HLS segment URI');
      addReference(info.segmentUrls, resolveHttp(attrs.URI, baseUrl));
    } else if (tag === '#EXT-X-KEY' || tag === '#EXT-X-SESSION-KEY') {
      const attrs = attributes(value);
      if (!attrs.METHOD) throw new Error('Missing HLS protection method');
      if (attrs.METHOD !== 'NONE' && !attrs.URI) throw new Error('Missing HLS key URI');
      if (attrs.METHOD !== 'NONE') info.protected = true;
      // Keys are protection evidence only; no key material is fetched or exposed as media.
    } else if (tag === '#EXT-X-ENDLIST') {
      info.live = false;
      media = true;
    } else if (tag === '#EXT-X-PLAYLIST-TYPE') {
      if (value !== 'VOD' && value !== 'EVENT') throw new Error('Invalid HLS playlist type');
      if (value === 'VOD') info.live = false;
      media = true;
    } else if (tag === '#EXT-X-TARGETDURATION') {
      positiveNumber(value, 'HLS target duration');
      media = true;
    } else if (tag === '#EXT-X-MEDIA-SEQUENCE') {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid HLS media sequence');
      media = true;
    }
    if (master && media) throw new Error('Mixed HLS master and media playlist');
  }
  if (stream || segmentDuration !== undefined) throw new Error('Missing HLS URI');
  if (!master && !media) throw new Error('Unsupported empty HLS playlist');
  if (media) info.duration = duration;
  return uniqueReferences(info);
}
