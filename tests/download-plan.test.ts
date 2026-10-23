import assert from 'node:assert/strict';
import test from 'node:test';
import type { DownloadStartRequest } from '../src/downloads/model.ts';
import type { Snapshot } from '../src/core/model.ts';
import { parseHls } from '../src/manifests/hls.ts';
import { selectDownload } from '../src/downloads/validation.ts';
import { resolveDownloadPlan } from '../src/downloads/plan.ts';

const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",DEFAULT=YES,URI="audio/list.m3u8?sig=a%2Fb&x=2"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="French",URI="fr/list.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,AUDIO="a"
https://media.test/720/playlist.jpg
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080,AUDIO="a"
https://media.test/1080/playlist.jpg`;
const source = 'https://media.test/master.m3u8?token=a%2Fb&z=2';
function fixture(text = master): Snapshot {
  const info = parseHls(text, source);
  return { version: 1, revision: 4, tabs: { 7: {
    id: 7, url: 'https://page.test/watch', epoch: 3, documentId: 'doc-current', documents: { 0: 'doc-current' },
    media: { [source]: { id: source, instance: 4, url: source, type: 'hls', status: 'confirmed', methods: ['network'],
      frameIds: [0], documentIds: ['doc-current'], elementIds: [], firstSeen: 1, lastSeen: 2,
      variants: info.variants, childUrls: info.childUrls, segmentUrls: [], protected: false } },
    updatedAt: 2, dropped: 0, errors: [],
  } } };
}
const request = { requestId: 'download-test-1', tabId: 7, epoch: 3, mediaId: source, instance: 4,
  variantId: 'hls:2', filename: 'Episode: one.mp4' };
const selected = () => selectDownload(fixture(), request);
const media = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment.ts?sig=a%2Fb&x=2\n#EXT-X-ENDLIST';
function fetcher(entries: Record<string, string | { text: string; final: string }>, seen: string[] = []) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); seen.push(url); init?.signal?.throwIfAborted();
    const entry = entries[url]; assert.ok(entry, 'unexpected manifest fetch');
    const response = new Response(typeof entry === 'string' ? entry : entry.text);
    Object.defineProperty(response, 'url', { value: typeof entry === 'string' ? url : entry.final });
    return response;
  };
}

test('selects a genuine requested quality with exact signed URLs and a safe output leaf', () => {
  const selection = selected();
  assert.equal(selection.height, 720);
  assert.equal(selection.videoUrl, 'https://media.test/720/playlist.jpg');
  assert.equal(selection.sourceUrl, source);
  assert.equal(selection.audioUrl, 'https://media.test/audio/list.m3u8?sig=a%2Fb&x=2');
  assert.equal(selection.filename, 'Episode_ one.mp4');
  assert.equal(selection.output, 'mp4');
  assert.equal(selection.documentId, 'doc-current');
});

test('rejects stale tab, epoch, instance and replaced document membership', () => {
  for (const override of [{ tabId: 8 }, { epoch: 2 }, { instance: 999 }])
    assert.throws(() => selectDownload(fixture(), { ...request, ...override }), /stale/i);
  const snapshot = fixture(); snapshot.tabs[7].documents[0] = 'replacement';
  assert.throws(() => selectDownload(snapshot, request), /stale/i);
});

test('rejects invalid supplied renditions and ineligible detector states without falling back', () => {
  for (const variantId of ['absent', 'hls:0']) assert.throws(() => selectDownload(fixture(), { ...request, variantId }), /rendition/i);
  for (const override of [{ type: 'direct' }, { status: 'observed' }, { protected: true }, { protected: undefined }, { live: true }]) {
    const snapshot = fixture(); Object.assign(snapshot.tabs[7].media[source], override);
    assert.throws(() => selectDownload(snapshot, request), /eligible/i);
  }
});

test('validates request shape and size and forces a Windows-safe mp4 leaf name', () => {
  for (const override of [{ requestId: '' }, { requestId: 'x'.repeat(129) }, { tabId: NaN }, { instance: -1 },
    { variantId: 2 }, { filename: 'x'.repeat(256) }, { unexpected: 'field' }])
    assert.throws(() => selectDownload(fixture(), { ...request, ...override } as unknown as DownloadStartRequest), /request/i);
  const name = selectDownload(fixture(), { ...request, filename: '../../CON.ts' }).filename;
  assert.ok(!/[<>:"/\\|?*\u0000-\u001f]/.test(name));
  assert.ok(!name.startsWith('.')); assert.ok(name.endsWith('.mp4'));
  assert.equal(selectDownload(fixture(), { ...request, filename: 'CON.mp4' }).filename, '_CON.mp4');
});

test('resolves only selected media and declared default audio, preserving redirect aliases and grants', async () => {
  const seen: string[] = [];
  const audio = 'https://media.test/audio/list.m3u8?sig=a%2Fb&x=2';
  const plan = await resolveDownloadPlan(selected(), fetcher({ [source]: master,
    'https://media.test/720/playlist.jpg': { text: '#EXTM3U\n#EXT-X-MAP:URI="chunk.mp4?sig=a%2Fb",BYTERANGE="8@0"\n#EXTINF:4,\n#EXT-X-BYTERANGE:10@8\nchunk.mp4?sig=a%2Fb\n#EXT-X-DISCONTINUITY\n#EXTINF:4,\n#EXT-X-BYTERANGE:12\nchunk.mp4?sig=a%2Fb\n#EXT-X-ENDLIST', final: 'https://edge.test/v/list.jpg?final=1' },
    [audio]: media,
  }, seen), new AbortController().signal);
  assert.deepEqual(seen, [source, 'https://media.test/720/playlist.jpg', audio]);
  assert.equal(plan.duration, 8);
  assert.equal(plan.selection.videoUrl, 'https://edge.test/v/list.jpg?final=1');
  assert.ok(plan.manifests.some(m => m.url === 'https://media.test/720/playlist.jpg'));
  assert.ok(plan.manifests.some(m => m.url === 'https://edge.test/v/list.jpg?final=1'));
  assert.deepEqual(plan.resources, [
    { url: 'https://edge.test/v/chunk.mp4?sig=a%2Fb', range: { start: 0, end: 7 } },
    { url: 'https://edge.test/v/chunk.mp4?sig=a%2Fb', range: { start: 8, end: 17 } },
    { url: 'https://edge.test/v/chunk.mp4?sig=a%2Fb', range: { start: 18, end: 29 } },
    { url: 'https://media.test/audio/segment.ts?sig=a%2Fb&x=2' },
  ]);
  assert.match(plan.manifests.find(m => m.url.includes('edge.test'))!.text, /EXT-X-DISCONTINUITY/);
});

test('fresh master excludes I-frame-only selections and rejects missing or ambiguous audio', async () => {
  for (const fresh of [
    master.replace('#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,AUDIO="a"\nhttps://media.test/720/playlist.jpg', '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,URI="https://media.test/720/playlist.jpg"'),
    master.replace('GROUP-ID="a"', 'GROUP-ID="other"').replace('GROUP-ID="a"', 'GROUP-ID="other"'),
    master.replace(',DEFAULT=YES', ''),
  ]) await assert.rejects(resolveDownloadPlan(selected(), fetcher({ [source]: fresh }), new AbortController().signal), /rendition|audio/i);
});

test('media-only sources are supported and require a complete clear bounded playlist', async () => {
  const snapshot = fixture(); Object.assign(snapshot.tabs[7].media[source], { variants: [], live: false });
  const selection = selectDownload(snapshot, { ...request, variantId: undefined });
  const plan = await resolveDownloadPlan(selection, fetcher({ [source]: media }), new AbortController().signal);
  assert.deepEqual(plan.resources, [{ url: 'https://media.test/segment.ts?sig=a%2Fb&x=2' }]);
  for (const text of [media.replace('#EXT-X-ENDLIST', ''), media.replace('#EXTINF', '#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF'),
    media.replace('#EXTINF', '#EXT-X-PART:DURATION=1,URI="partial"\n#EXTINF'), media.replace('#EXTINF', '#EXT-X-GAP\n#EXTINF'),
    media.replace('#EXTINF', '#EXT-X-BYTERANGE:10\n#EXTINF'), media.replace('#EXTINF', '#EXT-X-DEFINE:NAME="x",VALUE="y"\n#EXTINF')])
    await assert.rejects(resolveDownloadPlan(selection, fetcher({ [source]: text }), new AbortController().signal), /unsupported|protected|range|complete/i);
});

test('manifest transport enforces response, byte budget and abort without leaking private URLs', async () => {
  for (const response of [new Response('denied', { status: 403 }), new Response('x'.repeat(2 * 1024 * 1024 + 1))])
    await assert.rejects(resolveDownloadPlan(selected(), async () => response, new AbortController().signal), error => {
      assert.ok(error instanceof Error); assert.ok(!error.message.includes('token=')); return true;
    });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(resolveDownloadPlan(selected(), async () => { throw new Error('must not fetch'); }, controller.signal), /abort/i);
});


test('redirected masters and child aliases normalize absolute URIs without changing signed bytes', async () => {
  const original = 'https://media.test/720/list.m3u8?b=2&a=a%2Fb';
  const text = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\n720/list.m3u8?b=2&a=a%2Fb';
  const selection = selectDownload(fixture(text), { ...request, variantId: 'hls:0' });
  const plan = await resolveDownloadPlan(selection, fetcher({ [source]: { text, final: 'https://edge.test/path/master.m3u8?private=1' },
    'https://edge.test/path/720/list.m3u8?b=2&a=a%2Fb': { text: media, final: 'https://cdn.test/v.m3u8' },
  }), new AbortController().signal);
  assert.equal(selection.videoUrl, original);
  assert.equal(plan.selection.sourceUrl, source);
  assert.equal(plan.selection.videoUrl, 'https://cdn.test/v.m3u8');
  assert.match(plan.manifests[0].text, /https:\/\/edge.test\/path\/720\/list\.m3u8\?b=2&a=a%2Fb/);
  assert.match(plan.manifests.find(m => m.url === 'https://cdn.test/v.m3u8')!.text, /https:\/\/cdn.test\/segment.ts\?sig=a%2Fb&x=2/);
});

test('rejects malformed or unbound range grants and media constructs after ENDLIST', async () => {
  const snapshot = fixture(); Object.assign(snapshot.tabs[7].media[source], { variants: [], live: false });
  const selection = selectDownload(snapshot, { ...request, variantId: undefined });
  for (const text of [media + '\n#EXT-X-MAP:URI="late.mp4"',
    media.replace('#EXTINF', '#EXT-X-MAP:URI="init.mp4",BYTERANGE=""\n#EXTINF'),
    media.replace('#EXTINF', '#EXT-X-BYTERANGE:9007199254740992@0\n#EXTINF'),
    media.replace('#EXTINF', '#EXT-X-BYTERANGE:0@0\n#EXTINF'),
    media.replace('#EXTINF', '#EXT-X-DISCONTINUITY-SEQUENCE:-1\n#EXTINF'),
  ]) await assert.rejects(resolveDownloadPlan(selection, fetcher({ [source]: text }), new AbortController().signal), /unsupported|range/i);
});

test('a shared redirected video/audio playlist retains the actual final URL for both tracks', async () => {
  const combined = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Combined",DEFAULT=YES,URI="same.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720,AUDIO="a"\nsame.m3u8';
  const selection = selectDownload(fixture(combined), { ...request, variantId: 'hls:1' });
  const seen: string[] = [];
  const plan = await resolveDownloadPlan(selection, fetcher({ [source]: combined,
    'https://media.test/same.m3u8': { text: media, final: 'https://edge.test/combined.m3u8' } }, seen), new AbortController().signal);
  assert.equal(plan.selection.videoUrl, 'https://edge.test/combined.m3u8');
  assert.equal(plan.selection.audioUrl, 'https://edge.test/combined.m3u8');
  assert.equal(seen.length, 2);
  assert.equal(plan.resources.length, 1);
});


test('automatic selection chooses the highest normal video instead of a higher I-frame rendition', async () => {
  const text = '#EXTM3U\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=9000,RESOLUTION=3840x2160,URI="iframe.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=1280x720\n720.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000,RESOLUTION=1920x1080\n1080.m3u8';
  const selection = selectDownload(fixture(text), { ...request, variantId: undefined });
  const plan = await resolveDownloadPlan(selection, fetcher({ [source]: text, 'https://media.test/1080.m3u8': media }), new AbortController().signal);
  assert.equal(plan.selection.videoUrl, 'https://media.test/1080.m3u8');
  assert.equal(plan.selection.width, 1920); assert.equal(plan.selection.height, 1080);
  const explicit = selectDownload(fixture(text), { ...request, variantId: 'hls:0' });
  await assert.rejects(resolveDownloadPlan(explicit, fetcher({ [source]: text }), new AbortController().signal), /rendition/i);
});

test('uses the fresh declared default audio even when a different language was detected first', async () => {
  const text = master.replace('NAME="English",DEFAULT=YES', 'NAME="English"').replace('NAME="French"', 'NAME="French",DEFAULT=YES');
  const selection = selectDownload(fixture(text), request);
  assert.equal(selection.audioUrl, 'https://media.test/audio/list.m3u8?sig=a%2Fb&x=2');
  const seen: string[] = [];
  const plan = await resolveDownloadPlan(selection, fetcher({ [source]: text, 'https://media.test/720/playlist.jpg': media,
    'https://media.test/fr/list.m3u8': media }, seen), new AbortController().signal);
  assert.equal(plan.selection.audioUrl, 'https://media.test/fr/list.m3u8');
  assert.deepEqual(seen, [source, 'https://media.test/720/playlist.jpg', 'https://media.test/fr/list.m3u8']);
});

test('absolute-URI normalization remains inside the manifest byte budget', async () => {
  const snapshot = fixture(); Object.assign(snapshot.tabs[7].media[source], { variants: [], live: false });
  const selection = selectDownload(snapshot, { ...request, variantId: undefined });
  const padded = media.replace('#EXTM3U\n', '#EXTM3U\n#' + '#'.repeat(2 * 1024 * 1024 - media.length - 3) + '\n');
  assert.ok(new TextEncoder().encode(padded).length < 2 * 1024 * 1024);
  await assert.rejects(resolveDownloadPlan(selection, fetcher({ [source]: padded }), new AbortController().signal), /unsupported|limit/i);
});

test('URI normalization preserves quoted rendition metadata containing an apparent URI attribute', async () => {
  const text = master.replace('NAME="English"', 'NAME="English,URI=label"');
  const selection = selectDownload(fixture(text), request);
  const plan = await resolveDownloadPlan(selection, fetcher({ [source]: text,
    'https://media.test/720/playlist.jpg': media,
    'https://media.test/audio/list.m3u8?sig=a%2Fb&x=2': media,
  }), new AbortController().signal);
  const normalized = plan.manifests.find(manifest => manifest.url === source)!.text;
  assert.doesNotThrow(() => parseHls(normalized, source));
  assert.ok(normalized.includes('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English,URI=label",DEFAULT=YES,URI="https://media.test/audio/list.m3u8?sig=a%2Fb&x=2"'));
  assert.equal(plan.selection.audioUrl, 'https://media.test/audio/list.m3u8?sig=a%2Fb&x=2');
});
