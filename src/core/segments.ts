import { normalizeUrl } from './identity.ts';
import type { SegmentPattern, SegmentVariable } from './model.ts';

export const MAX_SEGMENT_PATTERNS = 200;
export const MAX_SEGMENT_GAPS = 4;
export const MAX_SEGMENT_DIGITS = 20;
export const MAX_SEGMENT_URL_LENGTH = 16_384;

export const segmentPatternKey = (pattern: SegmentPattern): string => JSON.stringify([pattern.literals, pattern.minDigits, pattern.variables]);

/** Snapshots carry data, never executable expressions or unbounded wildcards. */
export function validSegmentPattern(value: unknown): value is SegmentPattern {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const pattern = value as Record<string, unknown>;
  if (Object.keys(pattern).some(key => key !== 'literals' && key !== 'minDigits' && key !== 'variables') ||
      !Array.isArray(pattern.minDigits) || !Array.isArray(pattern.literals) || !Array.isArray(pattern.variables) ||
      pattern.minDigits.length < 1 || pattern.minDigits.length > MAX_SEGMENT_GAPS ||
      pattern.literals.length !== pattern.minDigits.length + 1 || pattern.variables.length !== pattern.minDigits.length) return false;
  if (!Array.from(pattern.minDigits).every(width => Number.isInteger(width) && width >= 1 && width <= MAX_SEGMENT_DIGITS) ||
      !Array.from(pattern.variables).every(variable => variable === 'Number' || variable === 'Time') ||
      !Array.from(pattern.literals).every(part => typeof part === 'string' && part.length <= MAX_SEGMENT_URL_LENGTH)) return false;
  const { literals, minDigits } = value as SegmentPattern;
  const sample = literals.reduce((url, literal, index) => url + (index ? '1'.padStart(minDigits[index - 1], '0') : '') + literal, '');
  return sample.length <= MAX_SEGMENT_URL_LENGTH && normalizeUrl(sample) === sample;
}

interface MatchState {
  position: number;
  Number?: string;
  Time?: string;
}

function canonicalDigits(digits: string): string {
  let first = 0;
  while (first < digits.length - 1 && digits[first] === '0') first++;
  return digits.slice(first);
}

/** Bind each of the two DASH variables once; repeated gaps must render that value at their own width. */
export function matchesSegmentPattern(url: string, pattern: SegmentPattern): boolean {
  if (url.length > MAX_SEGMENT_URL_LENGTH || !url.startsWith(pattern.literals[0])) return false;
  let states: MatchState[] = [{ position: pattern.literals[0].length }];
  for (let gap = 0; gap < pattern.minDigits.length; gap++) {
    const next = new Map<string, MatchState>();
    const literal = pattern.literals[gap + 1];
    const variable: SegmentVariable = pattern.variables[gap];
    const width = pattern.minDigits[gap];
    const record = (state: MatchState, rendered: string, value: string) => {
      const end = state.position + rendered.length;
      if (!url.startsWith(rendered, state.position) || !url.startsWith(literal, end)) return;
      const candidate = { ...state, position: end + literal.length, [variable]: value };
      next.set(`${candidate.position}:${candidate.Number ?? ''}:${candidate.Time ?? ''}`, candidate);
    };
    for (const state of states) {
      const known = state[variable];
      if (known !== undefined) { record(state, known.padStart(width, '0'), known); continue; }
      // Only the first occurrence of Number and Time branches: at most 20 × 20 states.
      for (let length = 1; length <= MAX_SEGMENT_DIGITS && state.position + length <= url.length; length++) {
        const digit = url.charCodeAt(state.position + length - 1);
        if (digit < 48 || digit > 57) break;
        if (length < width) continue;
        const digits = url.slice(state.position, state.position + length);
        const value = canonicalDigits(digits);
        if (value.padStart(width, '0') === digits) record(state, digits, value);
      }
    }
    if (!next.size) return false;
    states = [...next.values()];
  }
  return states.some(state => state.position === url.length);
}
