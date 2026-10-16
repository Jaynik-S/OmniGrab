import { normalizeUrl } from './identity.ts';
import type { SegmentPattern } from './model.ts';

export const MAX_SEGMENT_PATTERNS = 200;
export const MAX_SEGMENT_GAPS = 4;
export const MAX_SEGMENT_DIGITS = 20;
export const MAX_SEGMENT_URL_LENGTH = 16_384;

export const segmentPatternKey = (pattern: SegmentPattern): string => JSON.stringify([pattern.literals, pattern.minDigits]);

/** Snapshots carry data, never executable expressions or unbounded wildcards. */
export function validSegmentPattern(value: unknown): value is SegmentPattern {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const pattern = value as Record<string, unknown>;
  if (Object.keys(pattern).some(key => key !== 'literals' && key !== 'minDigits') ||
      !Array.isArray(pattern.minDigits) || !Array.isArray(pattern.literals) ||
      pattern.minDigits.length < 1 || pattern.minDigits.length > MAX_SEGMENT_GAPS ||
      pattern.literals.length !== pattern.minDigits.length + 1) return false;
  if (!Array.from(pattern.minDigits).every(width => Number.isInteger(width) && width >= 1 && width <= MAX_SEGMENT_DIGITS) ||
      !Array.from(pattern.literals).every(part => typeof part === 'string' && part.length <= MAX_SEGMENT_URL_LENGTH)) return false;
  const { literals, minDigits } = value as SegmentPattern;
  const sample = literals.reduce((url, literal, index) => url + (index ? '1'.padStart(minDigits[index - 1], '0') : '') + literal, '');
  return sample.length <= MAX_SEGMENT_URL_LENGTH && normalizeUrl(sample) === sample;
}

/** Match the complete signed URL with bounded digit scanning and no dynamic regular expression. */
export function matchesSegmentPattern(url: string, pattern: SegmentPattern): boolean {
  if (url.length > MAX_SEGMENT_URL_LENGTH || !url.startsWith(pattern.literals[0])) return false;
  let positions = new Set([pattern.literals[0].length]);
  for (let gap = 0; gap < pattern.minDigits.length; gap++) {
    const next = new Set<number>();
    const literal = pattern.literals[gap + 1];
    for (const start of positions) {
      for (let length = 1; length <= MAX_SEGMENT_DIGITS && start + length <= url.length; length++) {
        const digit = url.charCodeAt(start + length - 1);
        if (digit < 48 || digit > 57) break;
        if (length >= pattern.minDigits[gap] && url.startsWith(literal, start + length)) next.add(start + length + literal.length);
      }
    }
    if (!next.size) return false;
    positions = next;
  }
  return positions.has(url.length);
}
