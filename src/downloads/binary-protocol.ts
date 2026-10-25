import type { ByteRange, ResourceGrant } from './model.ts';
import { isValidBase64 } from './base64.ts';

export const BINARY_PORT = 'download-binary-v1:';
export const CHUNK_BYTES = 256 * 1024;
export const MAX_BODY_BYTES = 64 * 1024 * 1024;
export interface BinaryRequest { type: 'request'; jobId: string; requestId: string; url: string; range?: ByteRange; maxBytes: number; idleMs: number; expiresAt: number; }
export type BinaryMessage = BinaryRequest |
  { type: 'headers'; jobId: string; requestId: string; status: number; url: string; redirected: boolean; headers: [string, string][] } |
  { type: 'chunk'; jobId: string; requestId: string; sequence: number; offset: number; bytes: number; data: string } |
  { type: 'ack'; jobId: string; requestId: string; sequence: number; offset: number } |
  { type: 'end'; jobId: string; requestId: string; sequence: number; offset: number } |
  { type: 'error'; jobId: string; requestId: string; error: string } |
  { type: 'abort'; jobId: string; requestId: string };
export type BinaryPortMessage = BinaryMessage |
  { type: 'grants'; jobId: string; grants: ResourceGrant[] } |
  { type: 'ready'; jobId: string };
export function safeUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 16_384) throw new Error('download-url-invalid');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('download-url-invalid');
  return url.href;
}
export function validId(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value); }
export function validRange(value: ByteRange): boolean { return Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end) && value.start >= 0 && value.end >= value.start; }
export class BinaryGrants {
  private values: ResourceGrant[] = [];
  add(grants: ResourceGrant[]) {
    if (!Array.isArray(grants) || grants.length > 100_000) throw new Error('download-grants-invalid');
    const checked = grants.map(g => { const url = safeUrl(g.url); if (g.range && !validRange(g.range)) throw new Error('download-range-invalid'); return { url, ...(g.range ? { range: { ...g.range } } : {}) }; });
    for (const grant of checked) if (!this.values.some(g => g.url === grant.url && g.range?.start === grant.range?.start && g.range?.end === grant.range?.end)) this.values.push(grant);
  }
  permits(url: string, range?: ByteRange): boolean { return this.values.some(g => g.url === url && (!g.range || !!range && range.start >= g.range.start && range.end <= g.range.end)); }
}
export function decodeChunk(value: unknown): Uint8Array {
  const v = value as Extract<BinaryMessage, { type: 'chunk' }>;
  if (!v || v.type !== 'chunk' || !validId(v.jobId) || !validId(v.requestId) || !Number.isSafeInteger(v.sequence) || v.sequence < 0 || !Number.isSafeInteger(v.offset) || v.offset < 0 || !Number.isSafeInteger(v.bytes) || v.bytes < 1 || v.bytes > CHUNK_BYTES || typeof v.data !== 'string' || !isValidBase64(v.data, v.bytes)) throw new Error('download-chunk-invalid');
  const native = Uint8Array as typeof Uint8Array & { fromBase64?: (data: string) => Uint8Array };
  let result: Uint8Array;
  if (typeof native.fromBase64 === 'function') result = native.fromBase64(v.data);
  else {
    const raw = atob(v.data);
    result = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index++) result[index] = raw.charCodeAt(index);
  }
  if (result.length !== v.bytes) throw new Error('download-chunk-invalid');
  return result;
}
function encodeChunk(bytes: Uint8Array): string {
  const native = bytes as Uint8Array & { toBase64?: () => string };
  if (typeof native.toBase64 === 'function') return native.toBase64();
  let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(text);
}
function manifestResponse(response: Response, request: BinaryRequest): boolean {
  return request.maxBytes === 2 * 1024 * 1024 && !request.range && response.status === 200;
}
export function validateResponse(response: Response, request: BinaryRequest, restricted: boolean) {
  if (!response.ok || response.status !== 200 && response.status !== 206) throw new Error(`download-http:${response.status}`);
  if (response.type === 'opaque') throw new Error('download-opaque');
  if (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity' && !manifestResponse(response, request)) throw new Error('download-encoding');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || !manifestResponse(response, request) && Number(length) > request.maxBytes)) throw new Error('download-body-limit');
  if (response.status === 206) {
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
    if (!request.range || !match || !match.slice(1).every(n => Number.isSafeInteger(Number(n))) || Number(match[1]) !== request.range.start || Number(match[2]) > request.range.end || Number(match[2]) < request.range.start || Number(match[2]) >= Number(match[3]) || Number(match[2]) !== Math.min(request.range.end, Number(match[3]) - 1) || length !== null && Number(length) !== Number(match[2]) - Number(match[1]) + 1) throw new Error('download-range-mismatch');
  } else if (restricted || request.range && request.range.start !== 0) throw new Error('download-range-mismatch');
  else if (request.range && length === null) throw new Error('download-whole-length-required');
}
export interface ProducerControl { ack(sequence: number, offset: number): void; abort(): void; settled: Promise<void>; }

/** Producer holds its physical lease until fetch/read/cancel settles, including ACK waits. */
export function produceBinary(request: BinaryRequest, options: { fetcher: typeof fetch; grants: BinaryGrants; unrestricted: boolean; send: (message: BinaryMessage) => void; queued?: (delta: number) => void }): ProducerControl {
  const controller = new AbortController();
  let wake: (() => void) | undefined, wanted: { sequence: number; offset: number } | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let physicalReader: ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader | undefined;
  let cancellation: Promise<void> | undefined;
  controller.signal.addEventListener('abort', () => { if (physicalReader) cancellation = physicalReader.cancel(controller.signal.reason).catch(() => {}); }, { once: true });
  const timeout = () => controller.abort(new Error('download-timeout'));
  const touch = () => { clearTimeout(idle); idle = setTimeout(timeout, request.idleMs); };
  const total = setTimeout(timeout, Math.max(1, request.expiresAt - Date.now())); touch();
  const settled = (async () => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader | undefined, response: Response | undefined;
    let held = 0;
    const queue = (delta: number) => { held += delta; options.queued?.(delta); };
    const base = { jobId: request.jobId, requestId: request.requestId };
    try {
      if (!validId(request.jobId) || !validId(request.requestId) || request.url !== safeUrl(request.url) || request.range && !validRange(request.range) || !Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1 || request.maxBytes > MAX_BODY_BYTES || !Number.isSafeInteger(request.idleMs) || request.idleMs < 1 || request.idleMs > 15_000 || !Number.isSafeInteger(request.expiresAt) || request.expiresAt <= Date.now() || request.expiresAt > Date.now() + 120_000 || !options.grants.permits(request.url, request.range)) throw new Error('download-request-grant-invalid');
      const fetcher = options.fetcher;
      response = await fetcher(request.url, { method: 'GET', mode: 'cors', credentials: 'same-origin', redirect: 'follow', cache: 'no-store', headers: request.range ? { Range: `bytes=${request.range.start}-${request.range.end}` } : {}, signal: controller.signal });
      controller.signal.throwIfAborted(); touch(); validateResponse(response, request, !options.unrestricted);
      const finalUrl = response.url ? safeUrl(response.url) : request.url;
      options.send({ type: 'headers', ...base, status: response.status, url: finalUrl, redirected: response.redirected, headers: [...response.headers].filter(([k]) => ['content-type', 'content-length', 'content-range', 'content-encoding', 'accept-ranges', 'etag', 'last-modified'].includes(k)) });
      let offset = 0, sequence = 0;
      let read: (() => Promise<ReadableStreamReadResult<Uint8Array>>) | undefined;
      if (response.body) {
        try {
          const bounded = response.body.getReader({ mode: 'byob' }); reader = bounded;
          read = () => bounded.read(new Uint8Array(CHUNK_BYTES));
        } catch {
          // Non-byte test/custom streams have no BYOB support; reject any oversized physical read.
          const ordinary = response.body.getReader(); reader = ordinary; read = () => ordinary.read();
        }
      }
      physicalReader = reader;
      while (read) {
        const part = await read(); controller.signal.throwIfAborted(); touch(); if (part.done) break;
        if (offset + part.value.byteLength > request.maxBytes || part.value.byteLength > 1024 * 1024) throw new Error('download-body-limit');
        queue(part.value.byteLength);
        for (let start = 0; start < part.value.length; start += CHUNK_BYTES) {
          const bytes = part.value.subarray(start, start + CHUNK_BYTES);
          const next = offset + bytes.length;
          await new Promise<void>((resolve, reject) => {
            wanted = { sequence, offset: next };
            const abort = () => reject(controller.signal.reason);
            wake = () => { controller.signal.removeEventListener('abort', abort); resolve(); };
            controller.signal.addEventListener('abort', abort, { once: true });
            options.send({ type: 'chunk', ...base, sequence, offset, bytes: bytes.length, data: encodeChunk(bytes) });
            if (controller.signal.aborted) abort();
          });
          controller.signal.throwIfAborted(); offset = next; sequence++; touch();
        }
        queue(-part.value.byteLength);
      }
      // CORS may hide Content-Encoding. Manifest authority is the bounded decoded body, not wire length.
      const declared = manifestResponse(response, request) ? null : response.headers.get('content-length');
      const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/\d+$/);
      if (declared !== null && offset !== Number(declared) || range && offset !== Number(range[2]) - Number(range[1]) + 1) throw new Error('download-body-truncated');
      options.send({ type: 'end', ...base, sequence, offset });
    } catch (error) {
      controller.abort(error);
      try { if (cancellation) await cancellation; else if (reader) await reader.cancel(error); else await response?.body?.cancel(error); } catch { /* Fetch may already have errored. */ }
      options.send({ type: 'error', ...base, error: String(error instanceof Error ? error.message : error).slice(0, 1000) });
    } finally { clearTimeout(total); clearTimeout(idle); if (held) queue(-held); reader?.releaseLock(); }
  })();
  return { settled, abort: () => controller.abort(new Error('download-aborted')), ack: (sequence, offset) => { if (!wanted || sequence !== wanted.sequence || offset !== wanted.offset) { controller.abort(new Error('download-ack-invalid')); return; } wanted = undefined; const next = wake; wake = undefined; next?.(); } };
}
