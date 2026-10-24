import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { watchWorker } from '../src/downloads/worker-watchdog.ts';
import { createWorkerProgress } from '../src/downloads/worker-progress.ts';
import type { RemuxProgress } from '../src/downloads/model.ts';
import type { RemuxOptions } from '../src/downloads/remux.ts';
test('a silently terminated dedicated worker loses its lease after missing heartbeats',async()=>{
 let lost=0;const monitor=watchWorker(()=>lost++,25);await new Promise(r=>setTimeout(r,45));assert.equal(lost,1);monitor.dispose();
});
test('worker heartbeats renew its lease and disposal prevents a spurious failure',async()=>{
 let lost=0;const monitor=watchWorker(()=>lost++,60);await new Promise(r=>setTimeout(r,20));monitor.beat();await new Promise(r=>setTimeout(r,20));assert.equal(lost,0);monitor.dispose();await new Promise(r=>setTimeout(r,70));assert.equal(lost,0);
});

const packet = (inputBytes: number, outputBytes = 0, seconds = 0): RemuxProgress => ({ phase: 'processing', inputBytes, outputBytes, seconds, duration: 120 });

test('worker progress sends first actual input immediately even after an empty initial update', t => {
 t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
 const sent: RemuxProgress[] = []; const progress = createWorkerProgress(value => sent.push(value));
 try {
  progress.push(packet(0)); progress.push(packet(1));
  assert.deepEqual(sent.at(-1), packet(1));
  progress.push(packet(2)); assert.equal(sent.length, 2);
 } finally { progress.dispose(); }
});

test('worker packet bursts publish at most once per interval and retain the newest exact counters', t => {
 t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
 const sent: RemuxProgress[] = []; const progress = createWorkerProgress(value => sent.push(value));
 try {
  for (let n = 1; n <= 1000; n++) progress.push(packet(n, n * 2, n / 10));
  assert.deepEqual(sent, [packet(1, 2, 0.1)]);
  t.mock.timers.tick(249); assert.equal(sent.length, 1);
  t.mock.timers.tick(1); assert.deepEqual(sent.at(-1), packet(1000, 2000, 100));
  t.mock.timers.tick(1000); assert.equal(sent.length, 2);
 } finally { progress.dispose(); }
});

test('worker phase transitions bypass the timer and replace stale pending processing counters', t => {
 t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
 const sent: RemuxProgress[] = []; const progress = createWorkerProgress(value => sent.push(value), 100);
 try {
  progress.push(packet(1)); progress.push(packet(2));
  const finalizing: RemuxProgress = { ...packet(3, 10, 2), phase: 'finalizing' };
  progress.push(finalizing); assert.deepEqual(sent, [packet(1), finalizing]);
  t.mock.timers.tick(100); assert.equal(sent.length, 2);
 } finally { progress.dispose(); }
});

for (const terminal of ['complete', 'failed']) {
 test(`worker flush publishes final counters before ${terminal} and disposal prevents late messages`, t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const sent: Array<RemuxProgress | string> = []; const progress = createWorkerProgress(value => sent.push(value));
  progress.push(packet(1)); progress.push(packet(1000, 5000, 7.25));
  progress.flush(); progress.dispose(); sent.push(terminal);
  assert.deepEqual(sent, [packet(1), packet(1000, 5000, 7.25), terminal]);
  progress.flush(); progress.push(packet(2000)); t.mock.timers.tick(1000);
  assert.equal(sent.length, 3);
 });
}

test('worker progress disposal cancels pending publication without flushing it', t => {
 t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
 const sent: RemuxProgress[] = []; const progress = createWorkerProgress(value => sent.push(value), 10);
 progress.push(packet(1)); progress.push(packet(2)); progress.dispose();
 t.mock.timers.tick(100); assert.deepEqual(sent, [packet(1)]);
});

for (const terminal of ['complete', 'failed']) {
 test(`dedicated worker publishes newest counters before its actual ${terminal} message`, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1000 });
  const saved = ['self', 'navigator'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const fixtureKey = Symbol.for('download-worker-remux-fixture');
  const globals = globalThis as typeof globalThis & { [fixtureKey]?: (_plan: unknown, options: RemuxOptions) => Promise<unknown> };
  const messages: Array<{ type: string; progress?: RemuxProgress }> = [];
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const scope = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage(message: { type: string; progress?: RemuxProgress }) {
   messages.push(message); if (message.type === terminal) finish();
  } };
  // Replace only the expensive media engine. Worker lifecycle and OPFS setup remain real.
  globals[fixtureKey] = async (_plan, options) => {
   options.onProgress!(packet(1)); options.onProgress!(packet(1000, 5000, 7.25));
   if (terminal === 'failed') throw new Error('fixture remux failure');
   return { bytes: 5000, duration: 7.25, video: { codec: 'avc', width: 1280, height: 720 }, audio: { codec: 'aac', channels: 2, sampleRate: 48000 } };
  };
  const hooks = registerHooks({ load(url, context, nextLoad) {
   if (url === new URL('../src/downloads/remux.ts', import.meta.url).href) return { format: 'module', shortCircuit: true,
    source: "export async function remuxToMp4(...args) { return globalThis[Symbol.for('download-worker-remux-fixture')](...args); }" };
   return nextLoad(url, context);
  } });
  Object.defineProperty(globalThis, 'self', { configurable: true, value: scope });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: { async getDirectory() {
   return { async getDirectoryHandle() { return { async getFileHandle() { return { async createSyncAccessHandle() {
    return { truncate() {}, close() {} };
   } }; } }; } };
  } } } });
  try {
   await import(new URL(`../src/downloads/worker.ts?progress-test=${terminal}`, import.meta.url).href);
   scope.onmessage!({ data: { type: 'run', tempFile: 'fixture.mp4', plan: {} } });
   await finished;
   assert.deepEqual(messages.map(message => message.type), ['progress', 'progress', terminal]);
   assert.deepEqual(messages[1].progress, packet(1000, 5000, 7.25));
   t.mock.timers.tick(1000);
   assert.equal(messages.filter(message => message.type === 'progress').length, 2);
  } finally {
   hooks.deregister(); delete globals[fixtureKey];
   for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
   }
  }
 });
}
