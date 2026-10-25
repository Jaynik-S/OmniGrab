import test from 'node:test';
import assert from 'node:assert/strict';
import { windowFixture, verifySavedReceipt, digestFrameRecords } from './download-speed-fixture.ts';

test('window fixture keeps deterministic selected order and literal total bytes', () => {
  const { resources, text, expectedBytes } = windowFixture('https://fixture.test');
  assert.equal(resources.length, 32);
  assert.equal(resources[0]?.url, 'https://fixture.test/window-0.bin?size=524288');
  assert.equal(resources[3]?.url, 'https://fixture.test/window-3.bin?size=6360152');
  assert.equal(expectedBytes, 101358568);
  assert.equal(text.split('\n').filter(line => line.startsWith('https:')).length, 32);
});

test('decoded comparisons preserve each stream timing/content while ignoring cross-stream scheduling', async () => {
  const headers = ['#format: frame checksums', '#tb 0: 1/4', '#tb 1: 1/48000'];
  const video = '0, 0, 0, 1, 3, aaaa', laterVideo = '0, 1, 1, 1, 3, bbbb', audio = '1, 0, 0, 1024, 4, cccc';
  const first = await digestFrameRecords([...headers, video, audio, laterVideo]);
  const reordered = await digestFrameRecords([...headers, audio, video, laterVideo]);
  assert.deepEqual(first, reordered);
  assert.equal(first['0']?.records, 2); assert.equal(first['1']?.records, 1);
  assert.equal(first['1']?.timebase, '1/48000');
  assert.notDeepEqual(first, await digestFrameRecords([...headers, video, audio.replace('cccc', 'dddd'), laterVideo]));
  assert.notDeepEqual(first, await digestFrameRecords([...headers, video, audio, laterVideo.replace('0, 1, 1,', '0, 2, 2,')]));
  assert.notDeepEqual(first, await digestFrameRecords([...headers, laterVideo, audio, video]));
  assert.notDeepEqual(first, await digestFrameRecords([...headers.slice(0, 2), '#tb 1: 1/44100', video, audio, laterVideo]));
});

test('saved receipt requires actual Chrome completion, exact bytes and bounded activity', () => {
  const good = { chromeState:'complete', actualBytes:1234, expectedBytes:1234, maximumActive:4 };
  verifySavedReceipt(good);
  for (const change of [{chromeState:'in_progress'}, {actualBytes:1233}, {maximumActive:5}]) {
    assert.throws(() => verifySavedReceipt({...good,...change}));
  }
});
