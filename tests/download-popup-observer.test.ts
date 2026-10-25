import test from 'node:test';
import assert from 'node:assert/strict';
import { createPopupObserver } from './download-popup-observer.ts';

const job = { id: 'original-job', requestId: 'original-request', phase: 'complete', browserDownloadId: 42 };
const snapshot = { jobs: [job] };

test('closed popup reconnects to observe the original live job without another start', async () => {
  const messages: unknown[] = [];
  let reopens = 0;
  const diagnostics = { errorCount: 0, errors: [] as string[] };
  const observer = createPopupObserver({
    connection: { closed: true, close() {}, async evaluate() { throw Error('target closed'); } },
    recover: async () => {
      reopens++;
      return { closed: false, close() {}, async evaluate(_fn: unknown, message: unknown) { messages.push(message); return snapshot; } };
    },
    isAlive: () => true, diagnostics, onError: async () => {}, delay: async () => {},
  });
  const result = await observer.evaluate(() => {}, { type: 'download-snapshot' });
  assert.deepEqual(result, { jobs: [{ id: 'original-job', requestId: 'original-request', phase: 'complete', browserDownloadId: 42 }] });
  assert.deepEqual(messages, [{ type: 'download-snapshot' }]);
  assert.equal(reopens, 1);
});

test('observation deadlines and reopen failures retain live transfer and bound diagnostics', async () => {
  let attempts = 0, closes = 0;
  const messages: unknown[] = [];
  const diagnostics = { errorCount: 0, errors: [] as string[] };
  const observer = createPopupObserver({
    connection: { closed: false, close() { closes++; }, async evaluate() { throw Error('CDP timeout Runtime.evaluate'); } },
    recover: async () => {
      if (++attempts <= 25) throw Error('target missing: owned popup ' + 'x'.repeat(2000));
      return { closed: false, close() {}, async evaluate(_fn: unknown, message: unknown) { messages.push(message); return snapshot; } };
    },
    isAlive: () => true, diagnostics, onError: async () => {}, delay: async () => {},
  });
  assert.deepEqual(await observer.evaluate(() => {}, { type: 'download-snapshot' }), snapshot);
  assert.equal(closes, 1);
  assert.equal(diagnostics.errorCount, 26);
  assert.equal(diagnostics.errors.length, 20);
  assert.ok(diagnostics.errors.every(error => error.length <= 1000));
  assert.deepEqual(messages, [{ type: 'download-snapshot' }]);
});

test('permanent owned-browser death ends observation without restarting or declaring job failure', async () => {
  let alive = true, reopens = 0;
  const observer = createPopupObserver({
    connection: { closed: true, close() {}, async evaluate() { throw Error('target closed'); } },
    recover: async () => { reopens++; alive = false; throw Error('fetch failed'); },
    isAlive: () => alive, diagnostics: { errorCount: 0, errors: [] }, onError: async () => {}, delay: async () => {},
  });
  await assert.rejects(observer.evaluate(() => {}, { type: 'download-snapshot' }), /Owned browser closed; download outcome is unobserved/);
  assert.equal(reopens, 1);
});

test('a target closing during a pending read recovers the same snapshot request', async () => {
  const connection = { closed: false, close() {}, async evaluate() { this.closed = true; throw Error('socket disconnected'); } };
  const observer = createPopupObserver({
    connection,
    recover: async () => ({ closed: false, close() {}, async evaluate(_fn: unknown, arg: unknown) {
      assert.deepEqual(arg, { type: 'download-snapshot' }); return snapshot;
    } }),
    isAlive: () => true, diagnostics: { errorCount: 0, errors: [] }, onError: async () => {}, delay: async () => {},
  });
  assert.deepEqual(await observer.evaluate(() => {}, { type: 'download-snapshot' }), snapshot);
});

test('unexpected evaluation errors surface without a reconnect loop', async () => {
  let reopens = 0;
  const observer = createPopupObserver({
    connection: { closed: false, close() {}, async evaluate() { throw Error('extension snapshot schema invalid'); } },
    recover: async () => { reopens++; throw Error('unexpected reconnect'); },
    isAlive: () => true, diagnostics: { errorCount: 0, errors: [] }, onError: async () => {}, delay: async () => {},
  });
  await assert.rejects(observer.evaluate(() => {}, {}), /extension snapshot schema invalid/);
  assert.equal(reopens, 0);
});
