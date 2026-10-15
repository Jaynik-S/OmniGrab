/** Preserve byte-significant query order and values; fragments do not identify an HTTP resource. */
export function normalizeUrl(value: string): string | undefined {
  if (typeof value !== 'string' || value.length > 16384) return;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
    url.hash = '';
    return url.href;
  } catch { return; }
}
