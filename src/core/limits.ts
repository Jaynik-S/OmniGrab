/** Shared producer and persistence limits; URLs are rejected, never truncated. */
export const MAX_PERSISTED_STRING = 16_384;
export const MAX_REFERENCE_CHARS = 2 * 1024 * 1024;
export const MAX_CHILD_MANIFESTS = 100;
export const persistedText = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_PERSISTED_STRING;

export function boundedManifestValues(value: unknown): boolean {
  if (typeof value === 'string') return persistedText(value);
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(boundedManifestValues);
  if (value && typeof value === 'object') return Object.values(value).every(boundedManifestValues);
  return true;
}
