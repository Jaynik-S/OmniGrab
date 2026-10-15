import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl } from '../src/core/identity.ts';
import { classify } from '../src/core/classify.ts';
import { emptySnapshot, navigate, ingest, applyManifest, probeFailed } from '../src/core/reducer.ts';
import type { Observation, ManifestInfo } from '../src/core/model.ts';

const observation = (url: string, more: Partial<Observation> = {}): Observation => ({
  tabId: 1, frameId: 0, epoch: 1, documentId: 'doc-a', method: 'network',
  url, mime: 'video/mp4', statusCode: 200, observedAt: 1000, ...more,
});
const start = () => navigate(emptySnapshot(), 1, 'https://page.test/watch', 100, 'doc-a');

test('identity preserves signed queries and rejects credential-bearing or non-media schemes', () => {
  assert.equal(normalizeUrl('https://cdn.test/a?token=one&quality=2#track'), 'https://cdn.test/a?token=one&quality=2');
  assert.notEqual(normalizeUrl('https://cdn.test/a?token=one'), normalizeUrl('https://cdn.test/a?token=two'));
  assert.equal(normalizeUrl('https://user:secret@cdn.test/a'), undefined);
  assert.equal(normalizeUrl('javascript:alert(1)'), undefined);
});

test('MIME confirms extensionless WebM and small valid direct media', () => {
  assert.equal(classify(observation('https://cdn.test/file', { mime: 'video/webm', statusCode: 206, bytes: 100 }))?.kind, 'direct');
  assert.equal(classify(observation('https://cdn.test/file', { bytes: 100 }))?.status, 'confirmed');
});

test('HTML/errors/images and stream fragments are not confirmed videos', () => {
  for (const item of [
    observation('https://cdn.test/movie.mp4', { mime: 'text/html' }),
    observation('https://cdn.test/movie.mp4', { statusCode: 404 }),
    observation('https://cdn.test/video.jpg', { mime: 'image/jpeg' }),
    observation('https://cdn.test/part.ts', { mime: 'video/mp2t' }),
    observation('https://cdn.test/init.mp4'),
  ]) assert.equal(classify(item), undefined);
});

test('manifest signals request validation and blob URLs stay unresolved', () => {
  assert.deepEqual(classify(observation('https://cdn.test/master', { mime: 'application/vnd.apple.mpegurl' })), { kind: 'hls', status: 'observed', probe: true });
  assert.equal(classify(observation('blob:https://page.test/id', { method: 'dom', mime: undefined }))?.status, 'unresolved');
  assert.equal(classify(observation('https://cdn.test/c.mp4', { method: 'resource', mime: undefined }))?.status, 'observed');
  assert.equal(classify(observation('https://cdn.test/image.jpg', { method: 'resource', mime: undefined })), undefined);
});

test('repeated methods merge one source without merging unrelated videos or signed URLs', () => {
  let s = start();
  for (const o of [observation('https://cdn.test/a.mp4?key=1'), observation('https://cdn.test/a.mp4?key=1', { method: 'dom', observedAt: 1100 }), observation('https://cdn.test/a.mp4?key=2'), observation('https://cdn.test/b.mp4')]) s = ingest(s, o).state;
  assert.equal(Object.keys(s.tabs[1].media).length, 3);
  const a = Object.values(s.tabs[1].media).find(x => x.url.endsWith('key=1'))!;
  assert.deepEqual(a.methods, ['network', 'dom']);
  assert.equal(a.firstSeen, 1000);
  assert.equal(a.lastSeen, 1100);
});

test('a parsed parent groups only its explicitly known children', () => {
  let s = start();
  s = ingest(s, observation('https://cdn.test/child.m3u8', { mime: 'application/x-mpegurl' })).state;
  s = ingest(s, observation('https://cdn.test/unrelated.mp4')).state;
  const { state, probe } = ingest(s, observation('https://cdn.test/master.m3u8', { mime: 'application/x-mpegurl' }));
  assert.ok(probe);
  const info: ManifestInfo = { type: 'hls', variants: [{ id: '720', url: 'https://cdn.test/child.m3u8', height: 720 }], childUrls: ['https://cdn.test/child.m3u8'], segmentUrls: ['https://cdn.test/chunk.m4s'], live: false, protected: false };
  s = applyManifest(state, probe, info);
  assert.equal(Object.keys(s.tabs[1].media).length, 2);
  assert.ok(Object.values(s.tabs[1].media).some(x => x.url.endsWith('unrelated.mp4')));
  s = ingest(s, observation('https://cdn.test/child.m3u8', { mime: 'application/x-mpegurl' })).state;
  assert.equal(Object.keys(s.tabs[1].media).length, 2);
});

test('navigation fences old observations and pending parse results', () => {
  const { state, probe } = ingest(start(), observation('https://cdn.test/master.m3u8', { mime: 'application/x-mpegurl' }));
  assert.ok(probe);
  let s = navigate(state, 1, 'https://page.test/next', 2000, 'doc-b');
  s = ingest(s, observation('https://cdn.test/late.mp4')).state;
  s = applyManifest(s, probe, { type: 'hls', variants: [], childUrls: [], segmentUrls: [], protected: false, live: false });
  assert.equal(Object.keys(s.tabs[1].media).length, 0);
  assert.equal(s.tabs[1].epoch, 2);
});

test('failed probes retain the observed source and useful reason', () => {
  const { state, probe } = ingest(start(), observation('https://cdn.test/master.m3u8', { mime: 'application/x-mpegurl' }));
  assert.ok(probe);
  const s = probeFailed(state, probe, 'http-403');
  assert.equal(s.tabs[1].media[probe.itemId].status, 'unresolved');
  assert.equal(s.tabs[1].media[probe.itemId].reason, 'http-403');
});

test('subframe provenance merges under the correct tab and excludes a superseded document', () => {
  let s = start();
  s.tabs[1].documents['7'] = 'frame-new';
  s = ingest(s, observation('https://cdn.test/old.mp4', { frameId: 7, documentId: 'frame-old' })).state;
  s = ingest(s, observation('https://cdn.test/new.mp4', { frameId: 7, documentId: 'frame-new' })).state;
  assert.equal(Object.keys(s.tabs[1].media).length, 1);
  assert.deepEqual(Object.values(s.tabs[1].media)[0].frameIds, [7]);
});
