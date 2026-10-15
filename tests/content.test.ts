import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { collectMedia, collectResources, observeMedia } from '../src/content/collector.ts';
import { renderSnapshot } from '../src/popup/view.ts';
import type { TabState } from '../src/core/model.ts';

const pageUrl = 'https://page.test/watch/index.html';
function fixture(html: string): Document {
  return parseHTML(`<html><head><title>Fixture player</title></head><body>${html}</body></html>`).document as unknown as Document;
}

test('collects selected and alternative sources with stable element identity and exact signed queries', () => {
  const document = fixture('<video src="../fallback.mp4"><source src="../main.webm?token=a%2Bb&x=1" type="video/webm"><source src="../other.mp4" type="video/mp4"></video>');
  const video = document.querySelector('video')!;
  Object.defineProperties(video, {
    currentSrc: { value: 'https://cdn.test/selected.mp4?sig=%2B&sig=2' },
    videoWidth: { value: 1280 }, videoHeight: { value: 720 }, duration: { value: 12.5 },
  });
  const observations = collectMedia(document, pageUrl);
  assert.equal(observations.length, 4);
  assert.equal(observations[0].url, 'https://cdn.test/selected.mp4?sig=%2B&sig=2');
  assert.equal(observations[0].role, 'current');
  assert.equal(observations[0].width, 1280);
  assert.equal(observations[0].duration, 12.5);
  assert.equal(observations[2].url, 'https://page.test/main.webm?token=a%2Bb&x=1');
  assert.equal(observations[2].mime, 'video/webm');
  assert.equal(observations[2].role, 'alternative');
  assert.equal(observations[2].width, undefined, 'selected dimensions must not label another quality');
  assert.equal(new Set(observations.map(item => item.elementId)).size, 1);
  assert.equal(collectMedia(document, pageUrl)[0].elementId, observations[0].elementId);
  assert.ok(!('tabId' in observations[0]));
});

test('keeps blob context, resolves base URLs and excludes empty, data and executable schemes', () => {
  const document = fixture('<base href="https://cdn.test/assets/"><video src="blob:https://page.test/opaque"></video><audio src="track.mp3"></audio><video></video><video src="data:video/mp4;base64,AA"></video><video src="javascript:alert(1)"></video>');
  const observations = collectMedia(document, pageUrl);
  assert.deepEqual(observations.map(item => item.url), ['blob:https://page.test/opaque', 'https://cdn.test/assets/track.mp3']);
  assert.equal(observations[0].method, 'dom');
});

test('deduplicates current source alternatives and reaches nested open shadow roots', () => {
  const document = fixture('<div id="host"></div>');
  const shadow = document.querySelector('#host')!.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<video src="/one.mp4"><source src="/one.mp4" type="video/mp4"></video><span></span>';
  shadow.querySelector('span')!.attachShadow({ mode: 'open' }).innerHTML = '<audio src="/two.ogg"></audio>';
  const observations = collectMedia(document, pageUrl);
  assert.equal(observations.length, 2);
  assert.equal(observations[0].mime, 'video/mp4');
  assert.equal(observations[0].role, 'current');
  assert.equal(observations[1].url, 'https://page.test/two.ogg');
});

test('resource timing admits plausible media without treating arbitrary fetches or fragments as media', () => {
  const result = collectResources([
    { name: 'https://cdn.test/movie.mp4?token=x%2By', initiatorType: 'fetch' },
    { name: '/live/master.m3u8', initiatorType: 'xmlhttprequest' },
    { name: '/opaque', initiatorType: 'video' },
    { name: '/video.jpg', initiatorType: 'fetch' },
    { name: '/chunk.m4s', initiatorType: 'fetch' },
    { name: 'data:video/mp4;base64,AA', initiatorType: 'video' },
  ], pageUrl);
  assert.deepEqual(result.map(item => item.url), ['https://cdn.test/movie.mp4?token=x%2By', 'https://page.test/live/master.m3u8', 'https://page.test/opaque']);
  assert.ok(result.every(item => item.method === 'resource'));
});

test('observes inserted nested sources, changed attributes and metadata events without playback', async () => {
  const document = fixture('<div id="host"></div>');
  const batches: ReturnType<typeof collectMedia>[] = [];
  const observer = observeMedia(document, pageUrl, batch => batches.push(batch), { delay: 0 });
  document.querySelector('#host')!.innerHTML = '<div><video src="/first.mp4"></video></div>';
  await new Promise(resolve => setTimeout(resolve, 20));
  const video = document.querySelector('video')!;
  assert.ok(batches.flat().some(item => item.url.endsWith('/first.mp4')));
  video.setAttribute('src', '/second.mp4');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(batches.flat().some(item => item.url.endsWith('/second.mp4')));
  Object.defineProperty(video, 'duration', { value: 42 });
  video.dispatchEvent(new (document.defaultView!.Event)('loadedmetadata', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(batches.flat().some(item => item.url.endsWith('/second.mp4') && item.duration === 42));
  observer.disconnect();
});

test('bounds collection and resource output for excessive documents', () => {
  const document = fixture('<video src="/one.mp4"></video>'.repeat(700));
  assert.ok(collectMedia(document, pageUrl).length <= 400);
  assert.ok(collectResources(Array.from({ length: 700 }, (_, index) => ({ name: `https://cdn.test/${index}.mp4`, initiatorType: 'fetch' })), pageUrl).length <= 200);
});

test('refreshes document URL after same-document navigation when resolving sources', async () => {
  const document = fixture('<video src="first.mp4"></video>');
  Object.defineProperty(document, 'URL', { value: 'https://page.test/old/', configurable: true });
  const batches: ReturnType<typeof collectMedia>[] = [];
  const observer = observeMedia(document, 'https://page.test/old/', batch => batches.push(batch), { delay: 0 });
  try {
    Object.defineProperty(document, 'URL', { value: 'https://page.test/new/', configurable: true });
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'currentSrc', { value: 'https://page.test/new/second.mp4' });
    video.setAttribute('src', 'second.mp4');
    await new Promise(resolve => setTimeout(resolve, 20));
    const changed = batches.flat().filter(item => item.url.includes('second.mp4'));
    assert.deepEqual(changed.map(item => item.url), ['https://page.test/new/second.mp4']);
    assert.equal(changed[0].pageUrl, 'https://page.test/new/');
  } finally { observer.disconnect(); }
});

test('bounds inspected source children even when repeated URLs never fill the output limit', () => {
  const document = fixture(`<video>${'<source src="/same.mp4">'.repeat(20_001)}<source src="/beyond-budget.mp4"></video>`);
  const observations = collectMedia(document, pageUrl);
  assert.ok(observations.some(item => item.url === 'https://page.test/same.mp4'));
  assert.ok(!observations.some(item => item.url === 'https://page.test/beyond-budget.mp4'));
});

test('watches media in newly inserted shadow trees and stops reporting after disconnect', async () => {
  const document = fixture('<main></main>');
  const batches: ReturnType<typeof collectMedia>[] = [];
  const observer = observeMedia(document, pageUrl, batch => batches.push(batch), { delay: 0 });
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<video><source src="/shadow.webm" type="video/webm"></video>';
  document.querySelector('main')!.append(host);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(batches.flat().some(item => item.url.endsWith('/shadow.webm')));
  shadow.querySelector('source')!.setAttribute('src', '/changed.webm');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(batches.flat().some(item => item.url.endsWith('/changed.webm')));
  observer.disconnect();
  const count = batches.length;
  shadow.querySelector('source')!.setAttribute('src', '/after-disconnect.webm');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(batches.length, count);
});

test('popup renders page claims as text and exposes metadata, variants, copy and diagnostics', () => {
  const document = fixture('<main id="results"></main>');
  const target = document.querySelector<HTMLElement>('#results')!;
  const tab: TabState = {
    id: 7, url: pageUrl, title: '<img src=x onerror=alert(1)>', epoch: 2, documents: {}, updatedAt: 1234,
    dropped: 3, errors: ['Probe failed: blocked'], media: {
      media: { id: 'media', url: 'https://cdn.test/movie.mp4?sig=%2B', type: 'hls', status: 'confirmed',
        methods: ['dom', 'network'], frameIds: [0], documentIds: [], elementIds: ['media-1'], firstSeen: 1000, lastSeen: 1234,
        width: 1280, height: 720, duration: 42, mime: 'application/vnd.apple.mpegurl', title: '<script>bad()</script>',
        variants: [{ id: 'v1', url: 'https://cdn.test/720.m3u8', height: 720, bandwidth: 2_000_000 }], childUrls: [], segmentUrls: [],
      },
    },
  };
  let copied: string | undefined;
  renderSnapshot(target, { tab, revision: 9 }, url => { copied = url; });
  assert.equal(target.querySelector('img'), null);
  assert.equal(target.querySelector('script'), null);
  assert.ok(target.textContent!.includes('<script>bad()</script>'));
  assert.ok(target.textContent!.includes('1280 × 720'));
  assert.ok(target.textContent!.includes('dom, network'));
  assert.ok(target.textContent!.includes('https://cdn.test/720.m3u8'));
  assert.ok(target.textContent!.includes('Probe failed: blocked'));
  assert.ok(target.textContent!.includes('3'));
  target.querySelector<HTMLButtonElement>('button')!.click();
  assert.equal(copied, 'https://cdn.test/movie.mp4?sig=%2B');
});

test('popup explains absent snapshots and storage errors', () => {
  const document = fixture('<main></main>');
  const target = document.querySelector<HTMLElement>('main')!;
  renderSnapshot(target, { revision: 0, error: 'Session storage unavailable' }, () => {});
  assert.ok(target.textContent!.includes('No media observed'));
  assert.ok(target.textContent!.includes('Session storage unavailable'));
});
