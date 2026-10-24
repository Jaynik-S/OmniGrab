import test from 'node:test';
import assert from 'node:assert/strict';
import { BinaryGrants, CHUNK_BYTES, decodeChunk, produceBinary } from '../src/downloads/binary-protocol.ts';
import type { BinaryMessage, BinaryRequest } from '../src/downloads/binary-protocol.ts';

const chunk = { type: 'chunk' as const, jobId: 'j', requestId: 'r', sequence: 0, offset: 0, bytes: 3, data: 'AP+A' };
const lengths = [1, 2, 3, 8193, 262144];

// Scope feature shims to one test, including failure paths, on Node versions without the APIs.
async function withBase64(native: boolean, run: (calls: { decode: number; encode: number }) => Promise<void>) {
  const from = Object.getOwnPropertyDescriptor(Uint8Array, 'fromBase64');
  const to = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'toBase64');
  const calls = { decode: 0, encode: 0 };
  Object.defineProperty(Uint8Array, 'fromBase64', { configurable: true, value: native ? function (this: unknown, text: string) {
    assert.equal(this, Uint8Array); calls.decode++; return new Uint8Array(Buffer.from(text, 'base64'));
  } : undefined });
  Object.defineProperty(Uint8Array.prototype, 'toBase64', { configurable: true, value: native ? function (this: Uint8Array) {
    assert.ok(this instanceof Uint8Array); calls.encode++; return Buffer.from(this).toString('base64');
  } : undefined });
  try { await run(calls); }
  finally {
    if (from) Object.defineProperty(Uint8Array, 'fromBase64', from); else Reflect.deleteProperty(Uint8Array, 'fromBase64');
    if (to) Object.defineProperty(Uint8Array.prototype, 'toBase64', to); else Reflect.deleteProperty(Uint8Array.prototype, 'toBase64');
  }
}

for (const native of [false, true]) {
  test(`${native ? 'native' : 'fallback'} conversion preserves literal bytes and real producer messages at chunk boundaries`, async () => {
    await withBase64(native, async calls => {
      assert.deepEqual([...decodeChunk(chunk)], [0, 255, 128]);
      for (const length of lengths) {
        const expected = new Uint8Array(length);
        for (let i = 0; i < length; i++) expected[i] = [0, 255, 128, 1, 254][i % 5];
        const url = 'https://cdn.test/bytes';
        const grants = new BinaryGrants(); grants.add([{ url }]);
        const request: BinaryRequest = { type: 'request', jobId: 'j', requestId: 'r', url, maxBytes: CHUNK_BYTES, idleMs: 1000, expiresAt: Date.now() + 10_000 };
        const messages: BinaryMessage[] = [];
        const control = produceBinary(request, { grants, unrestricted: true,
          fetcher: async () => new Response(expected, { headers: { 'content-length': String(length) } }),
          send(message) {
            messages.push(message);
            if (message.type === 'chunk') queueMicrotask(() => control.ack(message.sequence, message.offset + message.bytes));
          },
        });
        await control.settled;
        const parts = messages.filter(m => m.type === 'chunk');
        assert.equal(parts.length, 1); assert.equal(parts[0].bytes, length);
        assert.equal(parts[0].data, Buffer.from(expected).toString('base64'));
        assert.deepEqual(decodeChunk(parts[0]), expected);
        assert.deepEqual(messages.at(-1), { type: 'end', jobId: 'j', requestId: 'r', sequence: 1, offset: length });
      }
      // A missing native fast path must fail even when the old conversion returns correct bytes.
      assert.deepEqual(calls, native ? { decode: 6, encode: 5 } : { decode: 0, encode: 0 });
    });
  });

  test(`${native ? 'native' : 'fallback'} decoder rejects malformed wire data before conversion`, async () => {
    await withBase64(native, async calls => {
      for (const invalid of [
        { data: 'AP A' }, { data: 'AP-A' }, { data: 'AP=A' }, { data: '=P+A' },
        { bytes: 1, data: 'AP+A' }, { bytes: 0, data: '' },
        { bytes: 262145, data: 'A'.repeat(349532) }, { data: 'A'.repeat(349532) },
        { sequence: -1 }, { sequence: 0.5 }, { sequence: Number.MAX_SAFE_INTEGER + 1 },
        { offset: -1 }, { offset: 0.5 }, { offset: Number.MAX_SAFE_INTEGER + 1 },
      ]) assert.throws(() => decodeChunk({ ...chunk, ...invalid }), /download-chunk-invalid/);
      // The syntactically valid wrong byte length must also be rejected after decoding.
      assert.equal(calls.decode, native ? 1 : 0);
      assert.throws(() => decodeChunk({ ...chunk, bytes: 2, data: 'AA==' }), /download-chunk-invalid/);
    });
  });
}
