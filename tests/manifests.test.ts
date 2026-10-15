import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseHls } from '../src/manifests/hls.ts';
import { parseDash } from '../src/manifests/dash.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('HLS master preserves quoted codecs, relative jpg child links and rendition groups', () => {
  const info = parseHls(fixture('master.m3u8'), 'https://cdn.test/path/master.m3u8?master=secret');
  assert.equal(info.type, 'hls');
  assert.deepEqual(info.variants.filter(v => v.kind === 'video').map(v => [v.height, v.bandwidth, v.codecs, v.group]), [
    [720, 1500000, 'avc1.4d401f,mp4a.40.2', 'aud'],
    [1080, 3000000, 'avc1.640028,mp4a.40.2', 'aud'],
  ]);
  assert.deepEqual(info.variants.filter(v => v.kind !== 'video').map(v => [v.kind, v.group, v.language]), [['audio', 'aud', 'en'], ['subtitles', 'subs', 'fr']]);
  assert.equal(info.variants.find(v => v.height === 720)?.audioGroup, 'aud');
  assert.equal(info.variants.find(v => v.height === 720)?.subtitleGroup, 'subs');
  assert.deepEqual(info.childUrls, ['https://cdn.test/path/audio/en.m3u8?sig=a%2Fb', 'https://cdn.test/path/subs/fr.m3u8', 'https://cdn.test/path/720.jpg?child=1%2F2', 'https://cdn.test/1080.m3u8']);
  assert.deepEqual(info.segmentUrls, []);
  assert.equal(info.protected, false);
});

test('HLS media reports VOD duration, initialization and segment references without copying tokens', () => {
  const info = parseHls(fixture('media.m3u8'), 'https://cdn.test/path/media.m3u8?master=secret');
  assert.equal(info.live, false);
  assert.equal(info.duration, 12.75);
  assert.equal(info.protected, true);
  assert.deepEqual(info.childUrls, []);
  assert.deepEqual(info.segmentUrls, ['https://cdn.test/path/init.mp4?init=yes', 'https://cdn.test/path/chunks/80.m4s?sig=a%2Fb', 'https://cdn.test/path/chunks/81.m4s']);
  assert.deepEqual(info.variants, []);
});

test('HLS live playlists and session protection are recognized', () => {
  assert.equal(parseHls('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n1.ts', 'https://cdn.test/list').live, true);
  assert.equal(parseHls('#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://asset"\n#EXT-X-STREAM-INF:BANDWIDTH=1\na.m3u8', 'https://cdn.test/list').protected, true);
});

test('HLS rejects malformed structures, unsafe URLs and unbounded input', () => {
  for (const text of ['plain text', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1', '#EXTM3U\n#EXTINF:2,', '#EXTM3U\n#EXTINF:no,\na.ts', '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="bad', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\njavascript:alert(1)', '#EXTM3U\n#EXTINF:2,\nfoo.ts\n#EXT-X-STREAM-INF:BANDWIDTH=1\na.m3u8']) {
    assert.throws(() => parseHls(text, 'https://cdn.test/list'), Error, text);
  }
  assert.throws(() => parseHls('#EXTM3U\n' + '#'.repeat(2 * 1024 * 1024), 'https://cdn.test/list'), /limit|large/i);
});

test('DASH inherits bases and metadata across periods, adaptations and representations', () => {
  const info = parseDash(fixture('manifest.mpd'), 'https://cdn.test/manifests/master.mpd?master=secret');
  assert.equal(info.type, 'dash');
  assert.equal(info.live, false);
  assert.equal(info.duration, 62.5);
  assert.equal(info.protected, true);
  assert.deepEqual(info.variants.map(v => [v.representationId, v.kind, v.height, v.language, v.codecs]), [
    ['v720', 'video', 720, undefined, 'avc1.4d401f'], ['v1080', 'video', 1080, undefined, 'avc1.4d401f'],
    ['a1', 'audio', undefined, 'en', 'mp4a.40.2'], ['s1', 'subtitles', undefined, 'fr', undefined], ['v2', 'video', undefined, undefined, undefined],
  ]);
  assert.deepEqual(info.childUrls, ['https://cdn.test/assets/first/video/720/', 'https://cdn.test/assets/first/video/1080.mp4?sig=x%2Fy&k=2', 'https://cdn.test/assets/first/audio.mp4', 'https://cdn.test/assets/first/fr.vtt', 'https://cdn.test/assets/second/last.webm']);
  assert.deepEqual(info.segmentUrls, ['https://cdn.test/assets/first/video/720/init-v720.mp4', 'https://cdn.test/assets/first/video/start.mp4', 'https://cdn.test/assets/first/audio-init.mp4', 'https://cdn.test/assets/first/audio-1.m4s']);
});

test('DASH template-only representations remain discoverable without invented segment URLs', () => {
  const info = parseDash('<MPD type="dynamic"><Period><AdaptationSet contentType="video"><SegmentTemplate media="$Number$.m4s"/><Representation id="v" bandwidth="90"/></AdaptationSet></Period></MPD>', 'https://cdn.test/master.mpd?secret=1');
  assert.equal(info.live, true);
  assert.equal(info.variants[0]?.url, undefined);
  assert.equal(info.variants[0]?.bandwidth, 90);
  assert.deepEqual(info.childUrls, []);
  assert.deepEqual(info.segmentUrls, []);
});

test('DASH rejects malformed XML, entities, excessive depth and unsafe structures', () => {
  for (const xml of ['<MPD><Period></MPD>', '<html/>', '<!DOCTYPE MPD [<!ENTITY ext SYSTEM "file:///etc/passwd">]><MPD/>', '<MPD>&custom;</MPD>', '<MPD><Period><AdaptationSet><Representation><BaseURL>data:text/plain,media</BaseURL></Representation></AdaptationSet></Period></MPD>', '<MPD><BaseURL>a/</BaseURL><BaseURL>b/</BaseURL><Period/></MPD>']) {
    assert.throws(() => parseDash(xml, 'https://cdn.test/master.mpd'), Error, xml);
  }
  assert.throws(() => parseDash('<MPD>' + '<A>'.repeat(65) + '</A>'.repeat(65) + '</MPD>', 'https://cdn.test/m'), /depth/i);
  assert.throws(() => parseDash('<MPD>' + ' '.repeat(2 * 1024 * 1024) + '</MPD>', 'https://cdn.test/m'), /limit|large/i);
});

test('variant bounds report omissions, prioritize video and retain known child relationships', () => {
  const hls = parseHls('#EXTM3U\n' + Array.from({ length: 20 }, (_, i) => `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="${i}",URI="${i}.m3u8"`).join('\n') + '\n#EXT-X-STREAM-INF:BANDWIDTH=100\nvideo.jpg', 'https://cdn.test/master');
  assert.equal(hls.variants.length, 20);
  assert.equal(hls.truncated, 1);
  assert.equal(hls.variants.filter(v => v.kind === 'video').length, 1);
  assert.equal(new Set(hls.variants.map(v => v.id)).size, 20);
  assert.equal(hls.childUrls.length, 21);
  assert.equal(hls.childUrls.at(-1), 'https://cdn.test/video.jpg');
  const dash = parseDash('<MPD><Period><AdaptationSet contentType="audio">' + Array.from({ length: 20 }, (_, i) => `<Representation id="a${i}"><BaseURL>${i}.mp4</BaseURL></Representation>`).join('') + '</AdaptationSet><AdaptationSet contentType="video"><Representation id="v"><BaseURL>v.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>', 'https://cdn.test/m');
  assert.equal(dash.variants.length, 20);
  assert.equal(dash.truncated, 1);
  assert.equal(dash.variants.filter(v => v.kind === 'video').length, 1);
  assert.equal(dash.childUrls.length, 21);
});

test('HLS validates timing markers and reports declared VOD', () => {
  assert.equal(parseHls('#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:1,\na.ts', 'https://cdn.test/m').live, false);
  for (const text of ['#EXTM3U\n#EXT-X-TARGETDURATION:bad', '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:-1', '#EXTM3U\n#EXTINF:1,\n{$unresolved}.ts']) {
    assert.throws(() => parseHls(text, 'https://cdn.test/m'));
  }
});

test('DASH recognizes MP4 subtitle codecs, inherited XML language and namespaced MPD', () => {
  const info = parseDash('<d:MPD xmlns:d="urn:mpeg:dash:schema:mpd:2011"><d:Period><d:AdaptationSet mimeType="application/mp4" codecs="stpp.ttml.im1t" xml:lang="de"><d:Representation id="s"><d:BaseURL>sub.mp4</d:BaseURL></d:Representation></d:AdaptationSet></d:Period></d:MPD>', 'https://cdn.test/m');
  assert.equal(info.variants[0]?.kind, 'subtitles');
  assert.equal(info.variants[0]?.language, 'de');
});

test('HLS audio-only streams retain their kind instead of becoming video qualities', () => {
  const info = parseHls('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"\naudio.m3u8', 'https://cdn.test/m');
  assert.equal(info.variants[0]?.kind, 'audio');
});

test('invalid HLS timing cannot produce plausible discovery metadata', () => {
  assert.throws(() => parseHls('#EXTM3U\n#EXTINF:1e308,\na.ts\n#EXTINF:1e308,\nb.ts', 'https://cdn.test/m'));
});

test('incomplete HLS protection declarations are rejected', () => {
  assert.throws(() => parseHls('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128\n#EXTINF:1,\na.ts', 'https://cdn.test/m'));
});

test('overflowing DASH durations are rejected', () => {
  assert.throws(() => parseDash('<MPD mediaPresentationDuration="PT' + '9'.repeat(320) + 'S"><Period><AdaptationSet><Representation id="v"/></AdaptationSet></Period></MPD>', 'https://cdn.test/m'));
});

test('HLS initialization, low latency parts and I-frame links are explicit references', () => {
  const media = parseHls('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-PART:DURATION=0.25,URI="part.m4s?sig=1%2F2"\n#EXT-X-TARGETDURATION:2', 'https://cdn.test/live/list?parent=1');
  assert.deepEqual(media.segmentUrls, ['https://cdn.test/live/init.mp4', 'https://cdn.test/live/part.m4s?sig=1%2F2']);
  const master = parseHls('#EXTM3U\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100,RESOLUTION=640x360,URI="iframe.jpg"', 'https://cdn.test/live/master');
  assert.equal(master.variants[0]?.height, 360);
  assert.deepEqual(master.childUrls, ['https://cdn.test/live/iframe.jpg']);
});

test('excessive concrete segment lists fail explicitly rather than silently lose relationships', () => {
  assert.throws(() => parseHls('#EXTM3U\n' + '#EXTINF:1,\na.ts\n'.repeat(10_001), 'https://cdn.test/m'), /reference limit/i);
  assert.throws(() => parseDash('<MPD><Period><AdaptationSet><Representation><SegmentList>' + '<SegmentURL media="a.m4s"/>'.repeat(10_001) + '</SegmentList></Representation></AdaptationSet></Period></MPD>', 'https://cdn.test/m'), /reference limit/i);
});
