import assert from 'node:assert/strict';
import test from 'node:test';
import { createChangeNotifier } from '../src/downloads/change-notifier.ts';

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('coalesces progress to the latest status once per second with at most one in-flight notification', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10000 });
  let value = 0; let active = 0; let maximum = 0; const seen: number[] = []; const releases: (() => void)[] = [];
  const notifier = createChangeNotifier(async () => {
    active++; maximum = Math.max(maximum, active); seen.push(value);
    await new Promise<void>(resolve => releases.push(resolve)); active--;
  });
  try {
    notifier.notify(); await settle(); assert.deepEqual(seen, [0]);
    for (value = 1; value <= 100; value++) notifier.notify();
    value = 100; t.mock.timers.tick(2000); await settle(); assert.deepEqual(seen, [0]);
    releases.shift()!(); await settle(); assert.deepEqual(seen, [0, 100]);
    value = 101; notifier.notify(); releases.shift()!(); await settle();
    t.mock.timers.tick(999); await settle(); assert.deepEqual(seen, [0, 100]);
    value = 102; notifier.notify(); t.mock.timers.tick(1); await settle(); assert.deepEqual(seen, [0, 100, 102]);
    assert.equal(maximum, 1);
  } finally { notifier.dispose(); for (const release of releases) release(); await settle(); }
});

test('phase changes bypass the progress timer and survive an in-flight notification', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10000 });
  let phase = 'processing'; const seen: string[] = []; let release!: () => void;
  const notifier = createChangeNotifier(async () => { seen.push(phase); if (seen.length === 1) await new Promise<void>(resolve => { release = resolve; }); });
  notifier.notify(); await settle();
  phase = 'finalizing'; notifier.notify(true); await settle(); assert.deepEqual(seen, ['processing']);
  release(); await settle(); assert.deepEqual(seen, ['processing', 'finalizing']);
  notifier.notify(); await settle(); phase = 'ready-to-save'; notifier.notify(true); await settle();
  assert.deepEqual(seen, ['processing', 'finalizing', 'ready-to-save']);
  notifier.dispose(); t.mock.timers.tick(1000); await settle(); assert.equal(seen.length, 3);
});

test('disposal cancels pending timers and never waits for an in-flight coordinator response', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10000 });
  let sent = 0; let release!: () => void;
  const notifier = createChangeNotifier(async () => { sent++; await new Promise<void>(resolve => { release = resolve; }); });
  notifier.notify(); await settle(); notifier.notify(true);
  assert.equal(notifier.dispose(), undefined); // release holds the coordinator lock; waiting here would deadlock.
  release(); await settle(); t.mock.timers.tick(5000); notifier.notify(true); await settle(); assert.equal(sent, 1);
  const timer = createChangeNotifier(async () => { sent++; });
  timer.notify(); await settle(); timer.notify(); timer.dispose(); t.mock.timers.tick(5000); await settle(); assert.equal(sent, 2);
});

test('a rejected changed notification releases the in-flight slot for the latest phase', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10000 });
  let sent = 0;
  const notifier = createChangeNotifier(async () => { if (++sent === 1) throw Error('coordinator unavailable'); });
  notifier.notify(); notifier.notify(true); await settle(); assert.equal(sent, 2); notifier.dispose();
});
