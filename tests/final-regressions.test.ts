import test from 'node:test';
import assert from 'node:assert/strict';
import { DetectionStore } from '../src/background/store.ts';
import { ManifestProbe } from '../src/background/manifest-probe.ts';
import { applyManifest, bindDocument, emptySnapshot, ingest, navigate, probeStarted } from '../src/core/reducer.ts';
import { parseHls } from '../src/manifests/hls.ts';
import { parseDash } from '../src/manifests/dash.ts';
import type { Snapshot } from '../src/core/model.ts';

const master = 'https://cdn.test/master.m3u8';
const child = 'https://cdn.test/child.m3u8?sig=a%2Fb&x=1';
const segment = 'https://cdn.test/video-001.mp4?sig=a%2Fb&x=1';
const masterBody = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=1280x720\n${child}\n#EXT-X-STREAM-INF:BANDWIDTH=200\nunobserved.m3u8\n`;
const childBody = `#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:3,\n${segment}\n`;
const start = () => navigate(emptySnapshot(), 1, 'https://page.test/', 1, 'doc');
const observe = (s: Snapshot, url: string, method: 'network' | 'resource' = 'network') => ingest(s, { tabId: 1, frameId: 0, documentId: 'doc', url, method });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function parsedMaster(s = start()) {
  const result = observe(s, master);
  return applyManifest(result.state, result.probe!, parseHls(masterBody, master));
}

test('observed HLS children recover after restart and enrich the master without rendition fan-out', async () => {
  let s = parsedMaster();
  const observation = observe(s, child);
  assert.ok(observation.probe, 'an observed child needs its own durable parse work');
  s = probeStarted(observation.state, observation.probe);
  const fetched: string[] = [];
  const store = new DetectionStore({ load: async () => s, save: async () => {} });
  await new ManifestProbe(store, async url => { fetched.push(String(url)); return new Response(childBody); }).recover();
  s = observe(await store.read(), segment).state;
  assert.deepEqual(fetched, [child]);
  assert.deepEqual(Object.keys(s.tabs[1].media), [master]);
  const item = s.tabs[1].media[master];
  assert.equal(item.status, 'unsupported');
  assert.equal(item.live, true);
  assert.equal(item.variants[0].height, 720);
  assert.deepEqual(item.segmentUrls, [segment]);
});

test('an in-flight child result follows grouping to its master', async () => {
  const observation = observe(start(), child);
  const store = new DetectionStore({ load: async () => observation.state, save: async () => {} });
  let respond!: (response: Response) => void;
  const response = new Promise<Response>(resolve => { respond = resolve; });
  const pending = new ManifestProbe(store, async () => response).enqueue(observation.probe!);
  await tick();
  await store.dispatch(s => parsedMaster(s));
  respond(new Response(childBody));
  await pending;
  const item = (await store.read()).tabs[1].media[master];
  assert.equal(item.protected, true);
  assert.equal(item.live, true);
  assert.equal(item.variants[0].height, 720);
  assert.deepEqual(item.segmentUrls, [segment]);
});

test('failed child work is durable, bounded, and cannot downgrade a confirmed master', async () => {
  const observation = observe(parsedMaster(), child);
  const store = new DetectionStore({ load: async () => observation.state, save: async () => {} });
  await new ManifestProbe(store, async () => { throw new Error('bad'.repeat(10000)); }).recover();
  const s = await store.read();
  assert.equal(s.tabs[1].media[master].status, 'confirmed');
  assert.ok(s.tabs[1].errors.some(error => error.startsWith('child-manifest:')));
  assert.ok(s.tabs[1].errors.every(error => error.length <= 1000));
  let calls = 0;
  await new ManifestProbe(new DetectionStore({ load: async () => s, save: async () => {} }), async () => { calls++; return new Response(childBody); }).recover();
  assert.equal(calls, 0);
});

test('grouped child completions cannot cross document replacement', async () => {
  const observation = observe(start(), child);
  let s = parsedMaster(probeStarted(observation.state, observation.probe!));
  s = bindDocument(s, 1, 0, 'replacement');
  const before = s;
  assert.deepEqual(applyManifest(s, observation.probe!, parseHls(childBody, child)), before);
});

test('oversized signed references and persisted variant metadata are rejected explicitly', () => {
  assert.throws(() => parseHls(`#EXTM3U\n#EXTINF:3,\nvideo.mp4?sig=${'x'.repeat(17000)}\n`, master), /limit|length/i);
  for (const attr of ['CODECS', 'AUDIO', 'SUBTITLES']) {
    assert.throws(() => parseHls(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,${attr}="${'x'.repeat(17000)}"\na.m3u8`, master), /limit|length/i);
  }
  for (const attr of ['id', 'codecs', 'lang']) {
    assert.throws(() => parseDash(`<MPD><Period><AdaptationSet><Representation ${attr}="${'x'.repeat(17000)}"/></AdaptationSet></Period></MPD>`, 'https://cdn.test/a.mpd'), /limit|length/i);
  }
});

test('expanded manifest references have a bounded aggregate size', () => {
  const base = `https://cdn.test/${'x'.repeat(15000)}/master.m3u8`;
  assert.throws(() => parseHls(`#EXTM3U\n${Array.from({ length: 1000 }, (_, i) => `#EXTINF:1,\n${i}.mp4`).join('\n')}`, base), /limit/i);
});

test('rejected parser output preserves existing evidence through store restart', async () => {
  let saved = observe(start(), 'https://cdn.test/existing.mp4').state;
  const candidate = observe(saved, master); saved = candidate.state;
  const store = new DetectionStore({ load: async () => saved, save: async s => { saved = s; } });
  await new ManifestProbe(store, async () => new Response(`#EXTM3U\n#EXTINF:3,\na.mp4?${'x'.repeat(17000)}`)).recover();
  const restored = new DetectionStore({ load: async () => saved, save: async () => {} });
  const state = await restored.read();
  assert.equal(restored.error, undefined);
  assert.ok(state.tabs[1].media['https://cdn.test/existing.mp4']);
  assert.equal(state.tabs[1].media[master].status, 'unresolved');
});

test('accepted producer transitions round trip despite oversized observation metadata', async () => {
  let saved = start();
  const store = new DetectionStore({ load: async () => saved, save: async s => { saved = s; } });
  await store.dispatch(s => ingest(s, { tabId: 1, frameId: 0, documentId: 'doc', method: 'network', url: 'https://cdn.test/video.mp4', mime: 'video/mp4', title: 'x'.repeat(17000), poster: `https://cdn.test/p?${'x'.repeat(17000)}` }).state);
  const restored = new DetectionStore({ load: async () => saved, save: async () => {} });
  assert.deepEqual(await restored.read(), await store.read());
  assert.equal(restored.error, undefined);
});

test('weak resource candidates cannot block later confirmed network evidence or manifests', () => {
  for (const late of ['https://cdn.test/real', master, 'https://cdn.test/real.mpd']) {
    let s = start();
    for (let i = 0; i < 200; i++) s = observe(s, `https://cdn.test/${i}.mp4`, 'resource').state;
    const result = ingest(s, { tabId: 1, frameId: 0, documentId: 'doc', url: late, method: 'network', mime: late.endsWith('.m3u8') ? 'application/x-mpegurl' : late.endsWith('.mpd') ? 'application/dash+xml' : 'video/mp4' });
    assert.ok(result.state.tabs[1].media[late]);
    assert.equal(Object.keys(result.state.tabs[1].media).length, 200);
    assert.ok(result.state.tabs[1].dropped > 0);
    assert.ok(result.state.tabs[1].errors.includes('item-evicted'));
    if (late === master) {
      const grouped = applyManifest(result.state, result.probe!, { type: 'hls', variants: [], childUrls: [], segmentUrls: Array.from({ length: 200 }, (_, i) => `https://cdn.test/${i}.mp4`), protected: false });
      assert.deepEqual(Object.keys(grouped.tabs[1].media), [master]);
    }
  }
});

test('weak-first admission preserves existing confirmed sources', () => {
  let s = ingest(start(), { tabId: 1, frameId: 0, documentId: 'doc', url: 'https://cdn.test/confirmed', method: 'network', mime: 'video/mp4' }).state;
  for (let i = 0; i < 199; i++) s = observe(s, `https://cdn.test/${i}.mp4`, 'resource').state;
  s = observe(s, master).state;
  assert.ok(s.tabs[1].media[master]);
  assert.equal(s.tabs[1].media['https://cdn.test/confirmed'].status, 'confirmed');
});

test('observed explicit HLS renditions are probed despite misleading MIME but segments are not', async () => {
  const disguised = 'https://cdn.test/child.jpg';
  const initial = observe(start(), master);
  const s = applyManifest(initial.state, initial.probe!, parseHls(masterBody.replace(child, disguised), master));
  const result = ingest(s, { tabId: 1, frameId: 0, documentId: 'doc', url: disguised, method: 'network', statusCode: 200, mime: 'image/jpeg' });
  assert.ok(result.probe);
  const store = new DetectionStore({ load: async () => result.state, save: async () => {} });
  await new ManifestProbe(store, async () => new Response(childBody)).enqueue(result.probe);
  const next = observe(await store.read(), segment);
  assert.equal(next.probe, undefined);
  assert.equal(next.state.tabs[1].media[master].status, 'unsupported');
  assert.deepEqual(Object.keys(next.state.tabs[1].media), [master]);
});

test('a rendition observed as direct media before its master still gets validation after grouping', async () => {
  const disguised = 'https://cdn.test/child.jpg';
  let s = ingest(start(), { tabId: 1, frameId: 0, documentId: 'doc', url: disguised, method: 'dom' }).state;
  const initial = observe(s, master);
  s = applyManifest(initial.state, initial.probe!, parseHls(masterBody.replace(child, disguised), master));
  const store = new DetectionStore({ load: async () => s, save: async () => {} });
  await new ManifestProbe(store, async () => new Response(childBody)).recover();
  assert.equal((await store.read()).tabs[1].media[master].protected, true);
});

test('oversized negative response reasons cannot poison an accepted snapshot', async () => {
  const s = observe(start(), 'https://cdn.test/video.mp4').state;
  const result = ingest(s, { tabId: 1, frameId: 0, documentId: 'doc', url: 'https://cdn.test/video.mp4', method: 'network', mime: `image/${'x'.repeat(17000)}` });
  const store = new DetectionStore({ load: async () => result.state, save: async () => {} });
  const restored = await store.read();
  assert.equal(store.error, undefined);
  assert.equal(restored.tabs[1].media['https://cdn.test/video.mp4'].status, 'unresolved');
});

test('child work is bounded and excess observed renditions report omissions without invalidating restore', async () => {
  const initial = observe(start(), master);
  const children = Array.from({ length: 105 }, (_, i) => `https://cdn.test/${i}.m3u8`);
  let s = applyManifest(initial.state, initial.probe!, { type: 'hls', variants: [], childUrls: children, segmentUrls: [], protected: false });
  for (const url of children) s = observe(s, url).state;
  const store = new DetectionStore({ load: async () => s, save: async () => {} });
  let calls = 0;
  await new ManifestProbe(store, async () => { calls++; return new Response('#EXTM3U\n#EXT-X-ENDLIST'); }).recover();
  assert.equal(calls, 100);
  assert.ok((await store.read()).tabs[1].errors.includes('child-manifest-limit'));
  assert.equal(store.error, undefined);
});

test('replacing one frame fences grouped child work while preserving its master in another frame', () => {
  let s = bindDocument(parsedMaster(), 1, 7, 'iframe-old');
  const old = ingest(s, { tabId: 1, frameId: 7, documentId: 'iframe-old', url: child, method: 'network' });
  s = bindDocument(probeStarted(old.state, old.probe!), 1, 7, 'iframe-new');
  const next = ingest(s, { tabId: 1, frameId: 7, documentId: 'iframe-new', url: child, method: 'network' });
  assert.ok(next.probe);
  assert.notEqual(next.probe.instance, old.probe!.instance);
  assert.deepEqual(applyManifest(next.state, old.probe!, parseHls(childBody, child)), next.state);
  assert.equal(applyManifest(next.state, next.probe, parseHls(childBody, child)).tabs[1].media[master].protected, true);
});
