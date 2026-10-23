import assert from 'node:assert/strict';
import test from 'node:test';
import { OpfsOutput } from '../src/downloads/opfs.ts';

test('OPFS writer loops short writes, patches offsets, and flushes before final File access', async () => {
  const bytes = new Uint8Array(3); const events: string[] = [];
  const output = new OpfsOutput({
    write(data, options) { const count = Math.min(2, data.byteLength); bytes.set(new Uint8Array(data.buffer, data.byteOffset, count), options.at); events.push('write'); return count; },
    flush() { events.push('flush'); }, close() { events.push('close'); },
  });
  await output.write(Uint8Array.of(1, 2, 3), 0); await output.write(Uint8Array.of(9), 1);
  await output.flush(); await output.close();
  assert.deepEqual(bytes, Uint8Array.of(1, 9, 3));
  assert.deepEqual(events, ['write', 'write', 'write', 'flush', 'close']);
  await assert.rejects(output.write(Uint8Array.of(1), 0), /closed/i);
});

test('OPFS writer rejects invalid offsets and zero-progress writes', async () => {
  const output = new OpfsOutput({ write() { return 0; }, flush() {}, close() {} });
  await assert.rejects(output.write(Uint8Array.of(1), -1), /position/i);
  await assert.rejects(output.write(Uint8Array.of(1), Number.MAX_SAFE_INTEGER), /position/i);
  await assert.rejects(output.write(Uint8Array.of(1), 0), /write/i);
  await output.close();
});
