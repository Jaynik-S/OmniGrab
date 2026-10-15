import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestTracker } from '../src/background/network.ts';

test('network response uses the context captured at request start, with total range size', async () => {
  const tracker = new RequestTracker();
  let epoch = 1;
  tracker.start({ requestId: 'r', tabId: 3, frameId: 7, documentId: 'old' }, Promise.resolve({ epoch, pageUrl: 'https://page.test/' }));
  epoch = 2;
  const o = await tracker.response({ requestId: 'r', tabId: 3, frameId: 7, documentId: 'old', url: 'https://cdn.test/movie', statusCode: 206,
    responseHeaders: [{ name: 'Content-Type', value: 'video/mp4; codecs=avc' }, { name: 'Content-Range', value: 'bytes 0-99/7000' }, { name: 'Set-Cookie', value: 'SECRET' }] });
  assert.equal(o?.epoch, 1); assert.equal(o?.bytes, 7000); assert.equal(o?.documentId, 'old');
  assert.equal(o?.mime, 'video/mp4; codecs=avc'); assert.equal(JSON.stringify(o).includes('SECRET'), false);
});
test('unattributed responses and extension requests are excluded; request tracking is bounded', async () => {
  const tracker = new RequestTracker(2);
  const d = { requestId: 'missing', tabId: 2, frameId: 0, url: 'https://cdn.test/a.mp4', statusCode: 200 };
  assert.equal(await tracker.response(d), undefined);
  tracker.start({ ...d, tabId: -1 }, Promise.resolve({ epoch: 1, pageUrl: '' }));
  assert.equal(await tracker.response({ ...d, tabId: -1 }), undefined);
  for (const id of ['1', '2', '3']) tracker.start({ ...d, requestId: id }, Promise.resolve({ epoch: 1, pageUrl: '' }));
  assert.equal(await tracker.response({ ...d, requestId: '1' }), undefined);
  assert.equal((await tracker.response({ ...d, requestId: '3' }))?.tabId, 2);
});
