import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import type { MediaItem, TabState } from '../src/core/model.ts';
import { renderSnapshot } from '../src/popup/view.ts';

function item(url: string, more: Partial<MediaItem> = {}): MediaItem {
  return { id: url, url, type: 'hls', status: 'confirmed', methods: ['resource', 'manifest'],
    frameIds: [0], documentIds: ['doc-a'], elementIds: [], firstSeen: 1_000, lastSeen: 2_000,
    variants: [], childUrls: [], segmentUrls: [], ...more };
}

function render(items: MediaItem[], title = "Marvel's The Punisher S2:E1 - Cinejoy") {
  const document = parseHTML('<html><body><main></main></body></html>').document as unknown as Document;
  const target = document.querySelector<HTMLElement>('main')!;
  const tab: TabState = { id: 7, url: 'https://page.test/watch', title, epoch: 1,
    documents: { 0: 'doc-a' }, media: Object.fromEntries(items.map(source => [source.id, source])),
    updatedAt: 2_000, dropped: 0, errors: [] };
  let copied: string | undefined;
  renderSnapshot(target, { tab, revision: 3 }, url => { copied = url; });
  return { document, target, copied: () => copied };
}

test('presents a confirmed HLS source with the screenshot duration and readable quality choices', () => {
  const { target } = render([
    item('https://cdn.test/master.m3u8', { duration: 3189.56, variants: [
      { id: '720', kind: 'video', height: 720, url: 'https://cdn.test/720.jpg' },
      { id: '1080', kind: 'video', height: 1080, url: 'https://cdn.test/1080.jpg' },
    ] }),
    item('blob:https://page.test/player', { type: 'blob', status: 'unresolved', title: 'Local player', duration: 3189.56 }),
  ]);
  const primary = target.querySelector<HTMLElement>('.primary-media')!;
  assert.ok(primary, 'confirmed remote media needs a primary section');
  assert.equal(primary.querySelector('h3')?.textContent, "Marvel's The Punisher S2:E1 - Cinejoy");
  assert.match(primary.textContent!, /53:10/);
  assert.match(primary.textContent!, /Source protocol: HLS/);
  assert.match(primary.textContent!, /Qualities: 1080p · 720p/);
  assert.doesNotMatch(primary.textContent!, /blob:|Local player/);
  assert.ok(target.querySelector('.secondary-evidence')?.textContent?.includes('blob:https://page.test/player'));
  assert.equal(target.querySelector('.secondary-evidence')?.hasAttribute('open'), false);
  assert.ok(![...target.querySelectorAll('button')].some(button => /download/i.test(button.textContent!)));
});

test('keeps a disguised manifest response MIME and manifest byte size in source details', () => {
  const {target}=render([item('https://cdn.test/master.m3u8',{duration:3189.56,mime:'image/jpeg',bytes:216})]);
  const article=target.querySelector<HTMLElement>('.primary-media article')!;
  const visibleMetadata=[...article.children].filter(node=>node.tagName!=='DETAILS').map(node=>node.textContent).join(' ');
  assert.doesNotMatch(visibleMetadata,/image\/jpeg|216 bytes/);
  assert.match(article.querySelector('.source-details')!.textContent!,/Response MIME: image\/jpeg/);
  assert.match(article.querySelector('.source-details')!.textContent!,/Observed response bytes: 216/);
});

test('keeps confirmed direct, HLS and DASH sources primary without admitting local or unconfirmed rows', () => {
  const { target } = render([
    item('https://cdn.test/one.mp4', { type: 'direct' }),
    item('https://cdn.test/two.m3u8'),
    item('https://cdn.test/three.mpd', { type: 'dash' }),
    item('https://cdn.test/unverified.mp4', { type: 'direct', status: 'observed' }),
    item('blob:https://page.test/local', { type: 'blob', status: 'unresolved' }),
  ]);
  assert.equal(target.querySelectorAll('.primary-media article').length, 3);
  assert.equal(target.querySelectorAll('.secondary-evidence article').length, 2);
  assert.ok(!target.querySelector('.primary-media')!.textContent!.includes('unverified.mp4'));
});

test('does not borrow duration, dimensions or quality from another source or a local player', () => {
  const { target } = render([
    item('https://cdn.test/master.m3u8', { title: 'First remote source' }),
    item('https://cdn.test/other.mp4', { type: 'direct', title: 'Second remote source', duration: 13, width: 640, height: 360 }),
    item('blob:https://page.test/local', { type: 'blob', status: 'unresolved', duration: 3189.56, width: 1920, height: 1080 }),
  ]);
  const [first, second] = target.querySelectorAll('.primary-media article');
  assert.ok(first?.textContent?.includes('First remote source'));
  assert.doesNotMatch(first!.textContent!, /53:10|0:13|1920|1080|640|360/);
  assert.match(second!.textContent!, /0:13/);
  assert.doesNotMatch(second!.textContent!, /53:10|1080/);
});

test('explains blob-only evidence without claiming a confirmed remote file', () => {
  const { target } = render([item('blob:https://page.test/local', { type: 'blob', status: 'unresolved', duration: 3189.56 })]);
  assert.equal(target.querySelector('.primary-media'), null);
  const empty = target.querySelector('.empty');
  assert.ok(empty, 'local evidence needs an explanation of missing remote media');
  assert.match(empty.textContent!, /No confirmed remote source/);
  const secondary = target.querySelector('.secondary-evidence')!;
  assert.ok(secondary, 'local evidence needs a separate expandable section');
  assert.match(secondary.querySelector('summary')!.textContent!, /Local and unconfirmed evidence/);
  assert.match(secondary.textContent!, /blob:https:\/\/page.test\/local/);
  assert.ok(![...target.querySelectorAll('button')].some(button => /download/i.test(button.textContent!)));
});

test('opens failed manifest evidence prominently when no confirmed source is available', () => {
  const { target } = render([
    item('https://cdn.test/master.m3u8', { status: 'unresolved', reason: 'manifest-http:404' }),
    item('blob:https://page.test/local', { type: 'blob', status: 'unresolved', duration: 3189.56 }),
  ]);
  assert.equal(target.querySelector('.primary-media'), null);
  const empty = target.querySelector('.empty');
  assert.ok(empty, 'manifest failure must not present a confirmed source');
  assert.match(empty.textContent!, /No confirmed remote source/);
  const secondary = target.querySelector('.secondary-evidence')!;
  assert.ok(secondary, 'failed manifest evidence must remain inspectable');
  assert.ok(secondary.hasAttribute('open'), 'failed manifest must be visible without expanding evidence');
  assert.match(secondary.textContent!, /manifest-http:404/);
  assert.doesNotMatch(target.textContent!, /Cinejoy\.mp4|downloadable|Source protocol: MP4/i);
});

test('keeps signed source URLs and provenance inspectable while rendering page claims safely', () => {
  const url = 'https://cdn.test/master.m3u8?sig=%2B&sig=two';
  const { document, target, copied } = render([item(url, {
    title: '<img src=x onerror=alert(1)>', frameIds: [0, 7], documentIds: ['doc-a', 'doc-b'], elementIds: ['0:player'],
    reason: '<script>bad()</script>',
  })]);
  assert.equal(document.querySelector('img'), null);
  assert.equal(document.querySelector('script'), null);
  assert.equal(target.querySelector('h3')!.textContent, '<img src=x onerror=alert(1)>');
  const details = target.querySelector('.source-details')!;
  assert.ok(details, 'source URL and provenance must remain inspectable');
  assert.match(details.textContent!, /resource, manifest/);
  assert.match(details.textContent!, /Frames: 0, 7/);
  assert.match(details.textContent!, /Documents: doc-a, doc-b/);
  assert.match(details.textContent!, /Elements: 0:player/);
  assert.ok(details.textContent!.includes(url));
  details.querySelector<HTMLButtonElement>('button')!.click();
  assert.equal(copied(), url);
});

test('formats long durations and excludes audio rendition heights from video qualities', () => {
  const { target } = render([item('https://cdn.test/master.m3u8', { duration: 3600.2, variants: [
    { id: 'video', kind: 'video', height: 720 }, { id: 'duplicate', kind: 'video', height: 720 },
    { id: 'audio', kind: 'audio', height: 1080 },
  ] })]);
  const primary = target.querySelector('.primary-media')!;
  assert.ok(primary, 'confirmed remote media needs a primary section');
  assert.match(primary.textContent!, /1:00:00/);
  assert.equal(primary.querySelector('.qualities')!.textContent, 'Qualities: 720p');
});
