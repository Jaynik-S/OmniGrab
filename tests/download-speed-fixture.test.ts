import test from 'node:test';
import assert from 'node:assert/strict';
import { windowFixture, verifySavedReceipt } from './download-speed-fixture.ts';

test('window fixture keeps deterministic selected order and literal total bytes', () => {
  const { resources, text, expectedBytes } = windowFixture('https://fixture.test');
  assert.equal(resources.length, 32);
  assert.equal(resources[0]?.url, 'https://fixture.test/window-0.bin?size=524288');
  assert.equal(resources[3]?.url, 'https://fixture.test/window-3.bin?size=6360152');
  assert.equal(expectedBytes, 101358568);
  assert.equal(text.split('\n').filter(line => line.startsWith('https:')).length, 32);
});

test('saved receipt requires actual Chrome completion, exact bytes and bounded activity', () => {
  const good = { chromeState:'complete', actualBytes:1234, expectedBytes:1234, maximumActive:4 };
  verifySavedReceipt(good);
  for (const change of [{chromeState:'in_progress'}, {actualBytes:1233}, {maximumActive:5}]) {
    assert.throws(() => verifySavedReceipt({...good,...change}));
  }
});
