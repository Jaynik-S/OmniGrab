export const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

/** Message strings must fit the byte budget and represent well-formed UTF-8 text. */
export function validManifestText(value: unknown, maxBytes = MAX_MANIFEST_BYTES): value is string {
  if (typeof value !== 'string' || value.length > maxBytes) return false;
  const bytes = new TextEncoder().encode(value);
  return bytes.byteLength <= maxBytes && new TextDecoder('utf-8', { fatal: true }).decode(bytes) === value;
}

/** Stream the body under one byte budget; cancellation also releases a stalled reader. */
export async function readManifestBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('manifest-size-limit');
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new Error('manifest-size-limit');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let bytes = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parts: string[] = [];
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('manifest-size-limit');
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join('');
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
