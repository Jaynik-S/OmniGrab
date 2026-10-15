import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl } from '../src/core/identity.ts';
import { classify } from '../src/core/classify.ts';
import { emptySnapshot, navigate, ingest, applyManifest, probeFailed, probeStarted, bindDocument } from '../src/core/reducer.ts';
import * as core from '../src/core/reducer.ts';
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

test('DOM current sources need loaded metadata before direct confirmation', () => {
  const source = observation('https://cdn.test/arbitrary', { method: 'dom', mime: undefined, statusCode: undefined, role: 'current' });
  assert.equal(classify(source)?.status, 'observed');
  assert.equal(classify({ ...source, duration: 12 })?.status, 'confirmed');
  assert.equal(classify({ ...source, width: 640, height: 360 })?.status, 'confirmed');
  assert.equal(classify({ ...source, duration: 0, width: 0, height: 0 })?.status, 'observed');
  assert.equal(classify({ ...source, duration: Infinity })?.status, 'observed');
  assert.equal(classify({ ...source, role: 'alternative', duration: 12 })?.status, 'observed');
});

test('contradictory network responses retain the candidate with an unresolved reason', () => {
  const url = 'https://cdn.test/arbitrary';
  for (const more of [{ mime: 'text/html' }, { statusCode: 404 }]) {
    let s = ingest(start(), observation(url, { method: 'dom', mime: undefined, role: 'current', duration: 12 })).state;
    s = ingest(s, observation(url, more)).state;
    assert.equal(s.tabs[1].media[url].status, 'unresolved');
    assert.match(s.tabs[1].media[url].reason!, /network-(?:mime|http):/);
    s = ingest(s, observation(url, { method: 'dom', mime: undefined, role: 'current' })).state;
    assert.equal(s.tabs[1].media[url].status, 'unresolved');
    s = ingest(s, observation(url)).state;
    assert.equal(s.tabs[1].media[url].status, 'confirmed');
    assert.equal(s.tabs[1].media[url].reason, undefined);
  }
});

test('network manifest MIME upgrades an earlier extensionless DOM source and schedules validation', () => {
  const url = 'https://cdn.test/arbitrary';
  for (const [mime, kind] of [['application/vnd.apple.mpegurl', 'hls'], ['application/dash+xml', 'dash']] as const) {
    const initial = ingest(start(), observation(url, { method: 'dom', mime: undefined, role: 'current' }));
    const upgraded = ingest(initial.state, observation(url, { mime }));
    assert.equal(upgraded.state.tabs[1].media[url].type, kind);
    assert.equal(upgraded.state.tabs[1].media[url].status, 'observed');
    assert.equal(upgraded.probe?.kind, kind);
    assert.equal(upgraded.probe?.instance, upgraded.state.tabs[1].media[url].instance);
    assert.equal(ingest(upgraded.state, observation(url, { mime })).probe, undefined);
  }
  assert.equal(classify(observation('https://cdn.test/misleading.m3u8', { mime: 'application/dash+xml' }))?.kind, 'dash');
});

test('subframe replacement rejects every transition from the prior same-URL probe instance', () => {
  const url = 'https://cdn.test/master.m3u8';
  let s = bindDocument(start(), 1, 7, 'frame-old');
  const first = ingest(s, observation(url, { frameId: 7, documentId: 'frame-old', mime: 'application/x-mpegurl' }));
  assert.ok(first.probe);
  s = bindDocument(first.state, 1, 7, 'frame-new');
  const second = ingest(s, observation(url, { frameId: 7, documentId: 'frame-new', mime: 'application/x-mpegurl' }));
  assert.ok(second.probe);
  assert.equal(typeof first.probe.instance, 'number');
  assert.notEqual(first.probe.instance, second.probe.instance);
  const info: ManifestInfo = { type: 'hls', variants: [], childUrls: [], segmentUrls: [], protected: true, live: false };
  assert.strictEqual(applyManifest(second.state, first.probe, info), second.state);
  assert.strictEqual(probeFailed(second.state, first.probe, 'late-failure'), second.state);
  assert.strictEqual(probeStarted(second.state, first.probe), second.state);
  assert.equal(applyManifest(second.state, second.probe, info).tabs[1].media[url].status, 'unsupported');
});

test('late parent grouping preserves parsed child protection, metadata, variants and descendants', () => {
  const child = 'https://cdn.test/child.m3u8';
  const segment = 'https://cdn.test/full-segment.mp4';
  const descendant = 'https://cdn.test/audio.m3u8';
  const first = ingest(start(), observation(child, { mime: 'application/x-mpegurl', elementId: 'child' }));
  assert.ok(first.probe);
  let s = applyManifest(first.state, first.probe, { type: 'hls', variants: [{ id: 'audio', url: descendant, kind: 'audio' }], childUrls: [descendant], segmentUrls: [segment], protected: true, live: true, duration: 24 });
  const parent = ingest(s, observation('https://cdn.test/master.m3u8', { mime: 'application/x-mpegurl' }));
  assert.ok(parent.probe);
  s = applyManifest(parent.state, parent.probe, { type: 'hls', variants: [{ id: '720', url: child, height: 720 }], childUrls: [child], segmentUrls: [], protected: false, live: false });
  const item = s.tabs[1].media[parent.probe.itemId];
  assert.equal(item.status, 'unsupported');
  assert.equal(item.protected, true);
  assert.equal(item.reason, 'protected-manifest');
  assert.equal(item.duration, 24);
  assert.equal(item.live, true);
  assert.deepEqual(item.variants.map(v => v.id), ['720', 'audio']);
  assert.ok(item.childUrls.includes(descendant));
  assert.deepEqual(item.segmentUrls, [segment]);
  assert.deepEqual(item.elementIds, ['0:child']);
  s = ingest(s, observation(segment)).state;
  s = ingest(s, observation(descendant, { mime: 'application/x-mpegurl' })).state;
  assert.equal(Object.keys(s.tabs[1].media).length, 1);
});

test('grouped child observations attach live provenance that survives the original frame navigation', () => {
  const child = 'https://cdn.test/child.m3u8';
  const parent = ingest(start(), observation('https://cdn.test/master.m3u8', { mime: 'application/x-mpegurl' }));
  assert.ok(parent.probe);
  let s = applyManifest(parent.state, parent.probe, { type: 'hls', variants: [], childUrls: [child], segmentUrls: [], protected: false, live: false });
  s = bindDocument(s, 1, 7, 'frame-child');
  s = ingest(s, observation(child, { frameId: 7, documentId: 'frame-child', mime: undefined, method: 'dom', elementId: 'player', observedAt: 1200 })).state;
  s = bindDocument(s, 1, 0, 'doc-new');
  const item = s.tabs[1].media[parent.probe.itemId];
  assert.ok(item);
  assert.deepEqual(item.frameIds, [7]);
  assert.deepEqual(item.documentIds, ['frame-child']);
  assert.deepEqual(item.elementIds, ['7:player']);
  assert.deepEqual(item.methods, ['network', 'manifest', 'dom']);
  assert.equal(item.lastSeen, 1200);
});

test('frame state is bounded with diagnostics and removal frees its lifecycle state', () => {
  let s = start();
  for (let frameId = 1; frameId < 100; frameId++) s = bindDocument(s, 1, frameId, `frame-${frameId}`);
  s = bindDocument(s, 1, 100, 'overflow');
  assert.equal(Object.keys(s.tabs[1].documents).length, 100);
  assert.equal(s.tabs[1].documents[100], undefined);
  assert.equal(s.tabs[1].dropped, 1);
  assert.ok(s.tabs[1].errors.includes('document-limit'));
  s = ingest(s, observation('https://cdn.test/overflow.mp4', { frameId: 100, documentId: 'overflow' })).state;
  assert.equal(s.tabs[1].media['https://cdn.test/overflow.mp4'], undefined);
  s = ingest(s, observation('https://cdn.test/shared.mp4', { elementId: 'main' })).state;
  s = ingest(s, observation('https://cdn.test/shared.mp4', { frameId: 7, documentId: 'frame-7', elementId: 'nested' })).state;
  s = ingest(s, observation('https://cdn.test/frame.mp4', { frameId: 7, documentId: 'frame-7' })).state;
  const original = s;
  s = core.removeFrame(s, 1, 7);
  assert.equal(s.tabs[1].documents[7], undefined);
  assert.equal(s.tabs[1].media['https://cdn.test/frame.mp4'], undefined);
  assert.deepEqual(s.tabs[1].media['https://cdn.test/shared.mp4'].frameIds, [0]);
  assert.deepEqual(s.tabs[1].media['https://cdn.test/shared.mp4'].elementIds, ['0:main']);
  assert.equal(original.tabs[1].documents[7], 'frame-7');
  s = bindDocument(s, 1, 100, 'frame-new');
  assert.equal(s.tabs[1].documents[100], 'frame-new');
});

test('manifest variants in the immutable snapshot do not alias parser input', () => {
  const { state, probe } = ingest(start(), observation('https://cdn.test/master.m3u8', { mime: 'application/x-mpegurl' }));
  assert.ok(probe);
  const info: ManifestInfo = { type: 'hls', variants: [{ id: '720', height: 720 }], childUrls: [], segmentUrls: [], protected: false, live: false };
  const s = applyManifest(state, probe, info);
  info.variants[0].height = 1;
  assert.equal(s.tabs[1].media[probe.itemId].variants[0].height, 720);
  s.tabs[1].media[probe.itemId].variants[0].id = 'changed';
  assert.equal(info.variants[0].id, '720');
});

test('weaker DOM manifest claims cannot replace successful network media evidence', () => {
  const url = 'https://cdn.test/source';
  let s = ingest(start(), observation(url)).state;
  const weak = ingest(s, observation(url, { method: 'dom', mime: 'application/vnd.apple.mpegurl' }));
  s = weak.state;
  assert.equal(s.tabs[1].media[url].type, 'direct');
  assert.equal(s.tabs[1].media[url].status, 'confirmed');
  assert.equal(s.tabs[1].media[url].mime, 'video/mp4');
  assert.equal(weak.probe, undefined);
});

test('grouped segments retain provenance and failed child responses update the group', () => {
  const child = 'https://cdn.test/child.m3u8';
  const segment = 'https://cdn.test/chunk.m4s';
  const parent = ingest(start(), observation('https://cdn.test/master.m3u8', { mime: 'application/x-mpegurl' }));
  assert.ok(parent.probe);
  let s = applyManifest(parent.state, parent.probe, { type: 'hls', variants: [], childUrls: [child], segmentUrls: [segment], protected: false, live: false });
  assert.equal(s.tabs[1].media[parent.probe.itemId].protected, false);
  assert.equal(s.tabs[1].media[parent.probe.itemId].live, false);
  s = bindDocument(s, 1, 7, 'segment-document');
  s = ingest(s, observation(segment, { frameId: 7, documentId: 'segment-document', mime: 'video/mp4' })).state;
  assert.deepEqual(s.tabs[1].media[parent.probe.itemId].frameIds, [0, 7]);
  s = ingest(s, observation(child, { mime: 'text/html' })).state;
  assert.equal(s.tabs[1].media[parent.probe.itemId].status, 'unresolved');
  assert.equal(s.tabs[1].media[parent.probe.itemId].reason, 'network-mime:text/html');
  assert.equal(Object.keys(s.tabs[1].media).length, 1);
});

test('candidate, provenance, relationship and variant caps report dropped evidence', () => {
  let s = start();
  for (let index = 0; index < 201; index++) s = ingest(s, observation(`https://cdn.test/${index}.mp4`)).state;
  assert.equal(Object.keys(s.tabs[1].media).length, 200);
  assert.equal(s.tabs[1].dropped, 1);
  assert.ok(s.tabs[1].errors.includes('item-limit'));
  s = start();
  for (let index = 0; index < 101; index++) s = ingest(s, observation('https://cdn.test/shared.mp4', { elementId: String(index) })).state;
  assert.equal(s.tabs[1].media['https://cdn.test/shared.mp4'].elementIds.length, 100);
  assert.equal(s.tabs[1].dropped, 1);
  assert.ok(s.tabs[1].errors.includes('provenance-limit'));
  const parent = ingest(start(), observation('https://cdn.test/master.m3u8', { mime: 'application/x-mpegurl' }));
  assert.ok(parent.probe);
  s = applyManifest(parent.state, parent.probe, { type: 'hls', variants: Array.from({ length: 21 }, (_, id) => ({ id: String(id) })), childUrls: [],
    segmentUrls: Array.from({ length: 10001 }, (_, id) => `https://cdn.test/${id}.m4s`), protected: false, live: false });
  assert.equal(s.tabs[1].media[parent.probe.itemId].variants.length, 20);
  assert.equal(s.tabs[1].media[parent.probe.itemId].segmentUrls.length, 10000);
  assert.equal(s.tabs[1].dropped, 2);
  assert.ok(s.tabs[1].errors.includes('variant-limit'));
  assert.ok(s.tabs[1].errors.includes('relationship-limit'));
});
