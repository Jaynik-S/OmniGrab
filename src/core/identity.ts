import { persistedText } from './limits.ts';
/** Preserve byte-significant query order and values; fragments do not identify an HTTP resource. */
export function normalizeUrl(value: string): string | undefined {
  if (!persistedText(value)) return;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
    url.hash = '';
    return persistedText(url.href) ? url.href : undefined;
  } catch { return; }
}
