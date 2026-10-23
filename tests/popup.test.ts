import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import type { MediaItem, TabState } from '../src/core/model.ts';
import type { DownloadJob } from '../src/downloads/model.ts';
import { renderSnapshot } from '../src/popup/view.ts';

function item(url: string, more: Partial<MediaItem> = {}): MediaItem {
  return { id: url, url, type: 'hls', status: 'confirmed', methods: ['resource', 'manifest'],
    frameIds: [0], documentIds: ['doc-a'], elementIds: [], firstSeen: 1_000, lastSeen: 2_000,
    variants: [], childUrls: [], segmentUrls: [], ...more };
}

// Linkedom exposes select.value as a getter only; emulate the native setter in this test DOM.
function nativeSelect(select: HTMLSelectElement) {
  const get = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), 'value')!.get!;
  Object.defineProperty(select, 'value', { get() { return get.call(this); }, set(value: string) {
    for (const option of [...this.options] as HTMLOptionElement[]) option.selected = option.value === value;
  } });
  return select;
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

// Download controls must bind user edits to the exact detector source, never to a blob.
test('offers real quality/filename controls and sends the selected source identity', async () => {
  const source = item('https://cdn.test/master.m3u8', { protected: false, instance: 4, variants: [
    { id: 'v720', kind: 'video', height: 720, url: 'https://cdn.test/720.m3u8' },
    { id: 'v1080', kind: 'video', height: 1080, url: 'https://cdn.test/1080.m3u8' },
  ] });
  const { document, target } = render([source]);
  let started: any;
  const tab: TabState = { id: 7, epoch: 2, url: 'https://page.test/watch', title: 'A: safe/title',
    documents: { 0: 'doc-a' }, media: { [source.id]: source }, updatedAt: 2, dropped: 0, errors: [] };
  renderSnapshot(target, { tab, revision: 4 }, () => {}, { jobs: [], start: async request => { started = request; return { ok: false, error: { code: 'fixture', message: 'Fixture rejected' } }; } });
  const quality = target.querySelector<HTMLSelectElement>('select')!;
  assert.ok(quality, 'a real quality selector is required');
  assert.deepEqual([...quality.options].map(o => o.textContent), ['1080p', '720p']);
  assert.equal(target.querySelector<HTMLInputElement>('input')!.value, 'A_ safe_title.mp4');
  nativeSelect(quality).value = 'v720';
  quality.dispatchEvent(new document.defaultView!.Event('change'));
  const filename = target.querySelector<HTMLInputElement>('input')!;
  filename.value = 'My episode.mp4';
  filename.dispatchEvent(new document.defaultView!.Event('input'));
  target.querySelector<HTMLButtonElement>('.download-start')!.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(started.variantId, quality.value);
  assert.equal(started.mediaId, source.id);
  assert.equal(started.tabId, 7);
  assert.equal(started.epoch, 2);
  assert.equal(started.instance, 4);
  assert.equal(started.filename, 'My episode.mp4');
  assert.match(target.textContent!, /Output: MP4/);
  assert.match(target.textContent!, /Fixture rejected/);
});

test('disables protected, unknown-clearance, live and unsupported downloads with an explanation', () => {
  for (const more of [{ protected: true }, {}, { protected: false, live: true }, { protected: false, type: 'dash' as const }, { protected: false, status: 'unresolved' as const }, { protected: false, type: 'blob' as const, url: 'blob:https://page.test/id' }]) {
    const source = item('https://cdn.test/master.m3u8', more);
    const { target } = render([source]);
    const tab: TabState = { id: 7, epoch: 1, url: 'https://page.test/', documents: { 0: 'doc-a' }, media: { [source.id]: source }, updatedAt: 1, dropped: 0, errors: [] };
    renderSnapshot(target, { tab, revision: 1 }, () => {}, { jobs: [], start: async () => { throw Error('must not start'); } });
    assert.ok(target.querySelector('.download-unavailable')?.textContent, JSON.stringify(more));
    assert.equal(target.querySelector('.download-start'), null);
  }
});

test('preserves edits across refresh and reuses a request ID after a lost response', async () => {
  const source = item('https://cdn.test/master.m3u8', { protected: false, variants: [
    { id: 'v720', kind: 'video', height: 720, url: 'https://cdn.test/720.m3u8' },
    { id: 'v1080', kind: 'video', height: 1080, url: 'https://cdn.test/1080.m3u8' },
  ] });
  const { document, target } = render([source]);
  const tab: TabState = { id: 7, epoch: 1, url: 'https://page.test/', documents: { 0: 'doc-a' }, media: { [source.id]: source }, updatedAt: 1, dropped: 0, errors: [] };
  const requests: any[] = [];
  let release!: () => void;
  const options = { jobs: [], start: async (request: any) => { requests.push(request); await new Promise<void>(resolve => { release = resolve; }); throw Error('Response lost'); } };
  const refresh = () => renderSnapshot(target, { tab, revision: 1 }, () => {}, options);
  refresh();
  let filename = target.querySelector<HTMLInputElement>('input')!;
  assert.ok(filename, 'editable filename is required');
  filename.value = 'Keep this edit.mp4'; filename.dispatchEvent(new document.defaultView!.Event('input'));
  const quality = target.querySelector<HTMLSelectElement>('select')!;
  nativeSelect(quality).value = 'v720'; quality.dispatchEvent(new document.defaultView!.Event('change'));
  refresh();
  assert.equal(target.querySelector<HTMLInputElement>('input')!.value, 'Keep this edit.mp4');
  assert.equal(target.querySelector<HTMLSelectElement>('select')!.value, 'v720');
  const click = () => target.querySelector<HTMLButtonElement>('.download-start')!.click();
  click(); click(); refresh(); click(); assert.equal(requests.length, 1);
  release(); await new Promise(resolve => setTimeout(resolve, 0));
  click(); assert.equal(requests.length, 2); assert.equal(requests[0].requestId, requests[1].requestId);
  release(); await new Promise(resolve => setTimeout(resolve, 0));
  filename = target.querySelector<HTMLInputElement>('input')!;
  filename.value = 'A new intent.mp4'; filename.dispatchEvent(new document.defaultView!.Event('input'));
  click(); assert.notEqual(requests[2].requestId, requests[0].requestId);
  release(); await new Promise(resolve => setTimeout(resolve, 0));
});


function job(phase: DownloadJob['phase'] = 'processing'): DownloadJob {
  return { version: 1, id: 'job-a', requestId: 'request-a', phase, createdAt: 1, updatedAt: 2,
    selection: { tabId: 7, epoch: 1, mediaId: 'old-source', instance: 0, pageUrl: 'https://page.test/previous',
      frameId: 0, documentId: 'old-doc', sourceUrl: 'https://cdn.test/old.m3u8', videoUrl: 'https://cdn.test/720.m3u8',
      filename: '<script>episode</script>.mp4', output: 'mp4', height: 720 },
    progress: { phase: 'processing', inputBytes: 512, outputBytes: 768, seconds: 1, duration: 12 } };
}

test('keeps all jobs separate from a navigated source and renders honest phases and media bytes', () => {
  const source = item('https://cdn.test/new.m3u8', { protected: false, bytes: 216 });
  const { document, target } = render([source]);
  const tab: TabState = { id: 7, epoch: 2, url: 'https://page.test/new', documents: { 0: 'new-doc' }, media: { [source.id]: source }, updatedAt: 1, dropped: 0, errors: [] };
  for (const [phase, label] of Object.entries({ queued: 'Queued', resolving: 'Resolving HLS', processing: 'Processing media', 'ready-to-save': 'Preparing browser save', saving: 'Saving in Chrome', complete: 'Saved by Chrome', failed: 'Failed', canceled: 'Canceled', interrupted: 'Interrupted' })) {
    const record = job(phase as DownloadJob['phase']);
    renderSnapshot(target, { tab, revision: 1 }, () => {}, { jobs: [record], start: async () => { throw Error('unused'); } });
    const history = target.querySelector('.download-jobs'); assert.ok(history);
    assert.match(history.textContent!, /Earlier \/ other source/);
    assert.match(history.textContent!, /512 bytes.*768 bytes.*Total size unknown/);
    assert.doesNotMatch(history.textContent!, /216 bytes/);
    assert.equal(history.querySelector('.job-phase')?.textContent, label);
    assert.equal(document.querySelector('script'), null);
    assert.equal(target.querySelector('.media .download-job'), null);
  }
  const finalizing = job(); finalizing.progress.phase = 'finalizing';
  renderSnapshot(target, { tab, revision: 2 }, () => {}, { jobs: [finalizing], start: async () => { throw Error('unused'); } });
  assert.equal(target.querySelector('.job-phase')?.textContent, 'Finalizing MP4');
});

test('wires cancel/retry and keeps structured recovery errors visible without unsafe retry', async () => {
  const { target } = render([]);
  let canceled: string | undefined; let retried: any;
  const options = { jobs: [job()], start: async () => { throw Error('unused'); },
    cancel: async (id: string) => { canceled = id; return { ok: false as const, error: { code: 'download-cleanup-pending', message: 'Close the original source tab to finish download cleanup.' } }; },
    retry: async (id: string, requestId: string) => { retried = { id, requestId }; throw Error('lost'); } };
  const refresh = () => renderSnapshot(target, { revision: 2 }, () => {}, options);
  refresh(); target.querySelector<HTMLButtonElement>('.download-cancel')!.click();
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(canceled, 'job-a');
  assert.match(target.textContent!, /download-cleanup-pending: Close the original source tab/);
  options.jobs = [job('failed')]; refresh(); target.querySelector<HTMLButtonElement>('.download-retry')!.click();
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(retried.id, 'job-a');
  const requestId = retried.requestId;
  target.querySelector<HTMLButtonElement>('.download-retry')!.click();
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(retried.requestId, requestId);
  const uncertain = job('interrupted'); uncertain.failure = { code: 'download-save-uncertain', message: 'The browser save cannot yet be confirmed.' };
  options.jobs = [uncertain]; refresh(); assert.equal(target.querySelector<HTMLButtonElement>('.download-retry')?.disabled, true);
  assert.match(target.textContent!, /The browser save cannot yet be confirmed/);
});

test('retains the same intent ID when the popup is recreated after a lost response', async () => {
  const memory = new Map<string, string>();
  const intentStorage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); } };
  const requests: any[] = [];
  const source = item('https://cdn.test/master.m3u8', { protected: false });
  const tab: TabState = { id: 7, epoch: 1, url: 'https://page.test/', title: 'Episode', documents: { 0: 'doc-a' }, media: { [source.id]: source }, updatedAt: 1, dropped: 0, errors: [] };
  for (let reopening = 0; reopening < 2; reopening++) {
    const { target } = render([source]);
    renderSnapshot(target, { tab, revision: 1 }, () => {}, { jobs: [], intentStorage, start: async request => { requests.push(request); throw Error('response lost'); } });
    target.querySelector<HTMLButtonElement>('.download-start')!.click();
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.equal(requests.length, 2);
  assert.equal(requests[0].requestId, requests[1].requestId);
});

test('keeps an explicitly selected quality unavailable instead of silently switching on a detection update', () => {
  const source = item('https://cdn.test/master.m3u8', { protected: false, variants: [
    { id: 'v1080', kind: 'video', height: 1080, url: 'https://cdn.test/1080.m3u8' },
    { id: 'v720', kind: 'video', height: 720, url: 'https://cdn.test/720.m3u8' },
  ] });
  const { document, target } = render([source]);
  const tab: TabState = { id: 7, epoch: 1, url: 'https://page.test/', documents: { 0: 'doc-a' }, media: { [source.id]: source }, updatedAt: 1, dropped: 0, errors: [] };
  const options = { jobs: [], start: async () => { throw Error('unused'); } };
  renderSnapshot(target, { tab, revision: 1 }, () => {}, options);
  const quality = nativeSelect(target.querySelector<HTMLSelectElement>('select')!);
  quality.value = 'v720'; quality.dispatchEvent(new document.defaultView!.Event('change'));
  source.variants = source.variants.filter(variant => variant.height !== 720);
  renderSnapshot(target, { tab, revision: 2 }, () => {}, options);
  assert.equal(target.querySelector<HTMLSelectElement>('select')!.value, 'v720');
  assert.equal(target.querySelector<HTMLButtonElement>('.download-start')!.disabled, true);
  assert.match(target.textContent!, /Selected quality is no longer confirmed/);
});
