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

test('OPFS output preserves safe quota and write reasons without private diagnostics', async () => {
  for (const operation of ['write', 'flush', 'close'] as const) {
    for (const name of ['QuotaExceededError', 'UnknownError']) {
      let closed = 0;
      const output = new OpfsOutput({
        write(data) { if (operation === 'write') throw new DOMException('private https://secret.test/?token=secret', name); return data.length; },
        flush() { if (operation === 'flush') throw new DOMException('private diagnostics', name); },
        close() { closed++; if (operation === 'close') throw new DOMException('private diagnostics', name); },
      });
      const action = operation === 'write' ? () => output.write(Uint8Array.of(1), 0) : () => output[operation]();
      await assert.rejects(action(), { message: name === 'QuotaExceededError' ? 'download-storage-quota-exceeded' : 'download-storage-write-failed' });
      if (operation !== 'close') await output.close();
      assert.equal(closed, 1);
    }
  }
});

test('OPFS creation errors are safe and failed initialization closes its exclusive handle', async () => {
  const { createOpfsOutput } = await import('../src/downloads/opfs.ts');
  for (const stage of ['create', 'open', 'truncate'] as const) {
    let closed = 0;
    const fail = () => { throw new DOMException('private URL', 'QuotaExceededError'); };
    const directory = { async getFileHandle() { if (stage === 'create') fail(); return { async createSyncAccessHandle() {
      if (stage === 'open') fail(); return { truncate: fail, close() { closed++; }, write() { return 0; }, flush() {} };
    } }; } } as unknown as FileSystemDirectoryHandle;
    await assert.rejects(createOpfsOutput(directory, 'owned.mp4'), { message: 'download-storage-quota-exceeded' });
    assert.equal(closed, stage === 'truncate' ? 1 : 0);
  }
});
