import type { ManifestInfo, SegmentPattern, Variant } from '../core/model.ts';
import { MAX_SEGMENT_PATTERNS, segmentPatternKey, validSegmentPattern } from '../core/segments.ts';
import { boundedManifestValues, MAX_REFERENCE_CHARS, persistedText } from '../core/limits.ts';

export const MAX_VARIANTS = 20;
const MAX_REFERENCES = 10_000;
const referenceSizes = new WeakMap<string[], number>();

export function checkText(text: string): void {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Empty manifest');
  if (text.length > 2 * 1024 * 1024 || new TextEncoder().encode(text).length > 2 * 1024 * 1024) {
    throw new Error('Manifest text exceeds 2 MiB limit');
  }
  if (text.includes('\0')) throw new Error('Invalid manifest NUL character');
}

export function resolveHttp(reference: string, baseUrl: string): string {
  if (reference.includes('{$')) throw new Error('Unsupported unresolved HLS URL variable');
  const url = new URL(reference, baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Unsafe manifest URL: HTTP(S) without credentials required');
  }
  url.hash = '';
  if (!persistedText(url.href)) throw new Error('Manifest URL length limit exceeded');
  return url.href;
}

export function addReference(target: string[], url: string): void {
  const size = (referenceSizes.get(target) ?? 0) + url.length;
  if (!persistedText(url) || size > MAX_REFERENCE_CHARS) throw new Error('Manifest reference size limit exceeded');
  if (target.length >= MAX_REFERENCES) throw new Error('Manifest reference limit exceeded');
  referenceSizes.set(target, size);
  target.push(url);
}

export function addSegmentPattern(info: ManifestInfo, pattern: SegmentPattern): void {
  if (!validSegmentPattern(pattern)) throw new Error('Invalid DASH template pattern or URL limit');
  const patterns = info.segmentPatterns ??= [];
  const key = segmentPatternKey(pattern);
  if (patterns.some(previous => segmentPatternKey(previous) === key)) return;
  if (patterns.length >= MAX_SEGMENT_PATTERNS) throw new Error('Manifest segment pattern limit exceeded');
  patterns.push(pattern);
}

export function addVariant(info: ManifestInfo, variant: Variant): void {
  if (!boundedManifestValues(variant)) throw new Error('Manifest variant value length limit exceeded');
  if (variant.url) addReference(info.childUrls, variant.url);
  variant.id = `${info.type}:${info.variants.length + (info.truncated ?? 0)}`;
  if (info.variants.length < MAX_VARIANTS) info.variants.push(variant);
  else {
    info.truncated = (info.truncated ?? 0) + 1;
    // Keep the first video qualities before less informative companion tracks.
    let companion = -1;
    for (let index = info.variants.length - 1; index >= 0; index--) {
      if (info.variants[index].kind !== 'video') { companion = index; break; }
    }
    if (variant.kind === 'video' && companion >= 0) info.variants.splice(companion, 1, variant);
  }
}

export function positiveNumber(value: string | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!value.trim() || !Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid ${field}`);
  return parsed;
}

export function uniqueReferences(info: ManifestInfo): ManifestInfo {
  const size = [...info.childUrls, ...info.segmentUrls, ...(info.segmentPatterns ?? []).flatMap(pattern => pattern.literals)].reduce((sum, url) => sum + url.length, 0);
  if (size > MAX_REFERENCE_CHARS) throw new Error('Manifest reference size limit exceeded');
  info.childUrls = [...new Set(info.childUrls)];
  info.segmentUrls = [...new Set(info.segmentUrls)];
  return info;
}
