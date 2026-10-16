import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FLOWER_BASE, startFixtures } from '../tests/browser/fixtures.mjs';

const options = Object.fromEntries(process.argv.slice(2).map(arg => { const [key, ...value] = arg.replace(/^--/, '').split('='); return [key, value.join('=') || true]; }));
const output = path.resolve(options.output || 'docs/rea-evidence/comparison/latest');
const trials = Number(options.trials || 3);
const windowMs = Number(options.window || 6500);
const POLL_MS = 200;
const ORIGINAL_ID = 'lmjnegcaeklhafolokijcfjliaokphfk';
const binary = process.env.CHROMIUM_PATH ?? path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1243/chrome-win64/chrome.exe');
const originalPath = process.env.ORIGINAL_EXTENSION_PATH ?? path.join(process.env.LOCALAPPDATA, `Google/Chrome/User Data/Default/Extensions/${ORIGINAL_ID}/10.6.1.2_0`);
const oursPath = path.resolve('dist');
let debugEndpoint;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// One monotonic host clock for requests, navigation, polls and rendered observations.
const hostNow = () => performance.timeOrigin + performance.now();
const safeUrl = value => {
  if (typeof value !== 'string') return value;
  try { const u = new URL(value); for (const key of [...u.searchParams.keys()]) if (/token|sign|auth|key|jwt|session/i.test(key)) u.searchParams.set(key, '[redacted]'); return u.href; } catch { return value.slice(0, 1000); }
};
const cleanError = error => String(error?.message ?? error).split('\n').slice(0, 3).join('\n').slice(0, 1500);
class ExpectationError extends Error {}

async function observeWorkerRequests(context, worker, prefix) {
  const requests = [];
  const observations = [];
  const listener = request => {
    if (!request.url().startsWith(prefix)) return;
    const sourceWorker = request.serviceWorker();
    const value = { url: safeUrl(request.url()), observedWallMs: hostNow(), source: sourceWorker?.url() ?? 'page-or-unattributed' };
    observations.push(value);
    if (sourceWorker?.url() === worker.url()) requests.push(value);
  };
  context.on('request', listener);
  return { requests, observations, close: () => context.off('request', listener) };
}

async function restartOwnWorker(context, page, worker, extensionId, tabId) {
  await worker.evaluate(value => { globalThis.__browserComparisonWorkerNonce = value; }, String(hostNow()));
  const cdp = await context.newCDPSession(page);
  const versions = new Map();
  cdp.on('ServiceWorker.workerVersionUpdated', event => event.versions.forEach(version => versions.set(version.versionId, version)));
  try {
    await cdp.send('ServiceWorker.enable'); await wait(250);
    const version = [...versions.values()].find(value => value.scriptURL === worker.url() && value.runningStatus === 'running');
    if (!version) throw new Error('Own running worker version unavailable');
    await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId }); await wait(350);
    const stopped = versions.get(version.versionId)?.runningStatus === 'stopped';
    if (!stopped) throw new ExpectationError('Actual pending-child worker stop was not observed');
    const wake = await context.newPage();
    try { await page.bringToFront(); await wake.goto(`chrome-extension://${extensionId}/popup/index.html`); await wake.evaluate(async id => chrome.runtime.sendMessage({ type: 'snapshot', tabId: id }), tabId); }
    finally { await wake.close(); }
    for (let attempt = 0; attempt < 30; attempt++) {
      const current = context.serviceWorkers().find(value => value.url() === worker.url());
      if (current) {
        const sentinelCleared = await current.evaluate(() => globalThis.__browserComparisonWorkerNonce === undefined);
        if (!sentinelCleared) throw new ExpectationError('Ephemeral own-worker sentinel survived worker stop');
        return { worker: current, evidence: { versionId: version.versionId, stopped, sentinelCleared, instrumentation: 'Ephemeral own-worker global sentinel only; no source/fetch modification', wokeWithOrdinarySnapshot: true } };
      }
      await wait(100);
    }
    throw new Error('Replacement worker did not become available');
  } finally { await cdp.detach(); }
}

async function exerciseHlsOrder(page, control, environment) {
  const { result, tabId, getWorker, replaceWorker, pausePolling, resumePolling, context, extensionId } = environment;
  const order = { mode: control.mode, expectedDuration: control.duration, expectedProtected: control.protected,
    protectionDeclarationOnly: control.protected, playbackClaim: false, stages: [], workerRequests: [], requestObservations: [] };
  result.order = order;
  let observer = await observeWorkerRequests(context, getWorker(), control.page);
  async function stateUntil(predicate, label, timeout = 5000) {
    const until = hostNow() + timeout;
    while (hostNow() < until) {
      const state = await getWorker().evaluate(oursSample, tabId);
      if (predicate(state)) { order.stages.push({ label, observedWallMs: hostNow(), state }); return state; }
      await wait(50);
    }
    throw new ExpectationError(`HLS order condition not observed: ${label}`);
  }
  async function fetchPage(url) {
    const status = await page.evaluate(async source => { const response = await fetch(source, { method: 'POST', signal: AbortSignal.timeout(3000) }); await response.arrayBuffer(); return response.status; }, url);
    if (status !== 200) throw new Error(`Order fixture HTTP ${status}: ${url}`);
  }
  try {
    if (control.childFirst) {
      await fetchPage(control.child);
      await stateUntil(state => state.items.some(item => item.url === control.child && item.status === 'probing'), 'independent child probe in progress');
      for (let attempt = 0; attempt < 50 && !observer.requests.some(request => request.url === control.child); attempt++) await wait(50);
      if (!observer.requests.some(request => request.url === control.child) || !control.heldCount()) throw new ExpectationError('Child probe was not observed in own worker and held at server');
    }
    await fetchPage(control.master);
    const parentState = await stateUntil(state => state.items.some(item => item.url === control.master && item.status === 'confirmed'), 'master parsed before child completion');
    order.parentFirstSeen = parentState.items.find(item => item.url === control.master).firstSeen;
    if (!control.childFirst) await fetchPage(control.child);
    await stateUntil(state => state.items.some(item => item.url === control.master && item.childManifests?.some(child => child.url === control.child && child.status === 'probing')), 'durable observed-child descriptor probing');
    if (control.restart) {
      order.workerRequests.push(...observer.requests); order.requestObservations.push(...observer.observations); observer.close(); observer = undefined;
      await pausePolling();
      try { const restarted = await restartOwnWorker(context, page, getWorker(), extensionId, tabId); replaceWorker(restarted.worker); order.restart = restarted.evidence; }
      finally { resumePolling(); }
      await stateUntil(state => state.items.some(item => item.url === control.master && item.childManifests?.some(child => child.url === control.child && ['observed', 'probing'].includes(child.status))), 'pending child restored after actual worker stop');
      observer = await observeWorkerRequests(context, getWorker(), control.page);
    }
    control.release();
    await stateUntil(state => state.items.some(item => item.url === control.master && item.childManifests?.some(child => child.url === control.child && child.status === 'confirmed') && Math.abs(item.duration - control.duration) < 0.001), 'selected child metadata merged into parent');
    await fetchPage(control.segment);
    const final = await stateUntil(state => {
      const remote = state.items.filter(item => /^https?:/.test(item.url));
      return remote.length === 1 && remote[0].url === control.master && remote[0].segmentUrls?.includes(control.segment);
    }, 'observed MP4 segment remains owned by one master');
    const owner = final.items.find(item => item.url === control.master);
    order.assessment = { onePrimaryGroup: final.items.filter(item => /^https?:/.test(item.url)).length === 1,
      childConfirmed: owner.childManifests.some(child => child.url === control.child && child.status === 'confirmed'),
      childDurationMerged: Math.abs(owner.duration - control.duration) < 0.001, childLiveMerged: owner.live === false,
      childProtectionMerged: owner.protected === control.protected, firstSeenPreserved: owner.firstSeen === order.parentFirstSeen,
      noUnusedChildWork: owner.childManifests.every(child => child.url !== control.unused) };
  } finally {
    if (observer) { order.workerRequests.push(...observer.requests); order.requestObservations.push(...observer.observations); observer.close(); }
    control.release();
    order.serverRequests = control.requests();
    order.noAutomaticUnusedFetch = !order.workerRequests.some(request => request.url === control.unused);
    order.noKeyFetch = !order.workerRequests.some(request => request.url.includes('never-request-key'));
  }
  order.passed = !!order.assessment && Object.values(order.assessment).every(Boolean) && order.noAutomaticUnusedFetch && order.noKeyFetch;
  if (!order.passed) throw new ExpectationError('HLS ordered-child metadata/grouping/fan-out assertion failed');
}

async function abortedFrameControl(page, fixture, getWorker, tabId) {
  const result = { status: 'blocked' };
  try {
    await page.goto(`${fixture.pageOrigin}/frame-lifecycle`); await wait(700);
    const frame = page.frames().find(value => value.url() === `${fixture.frameOrigin}/frame`);
    if (!frame) throw new Error('Initial cross-origin frame unavailable');
    result.before = await getWorker().evaluate(oursSample, tabId);
    const pendingUrl = `${fixture.frameOrigin}/frame-never-commits`;
    const requested = page.waitForRequest(request => request.url() === pendingUrl && request.isNavigationRequest(), { timeout: 2000 }).catch(error => error);
    await page.locator('iframe').evaluate((element, url) => { element.src = url; }, pendingUrl);
    const incoming = await requested; if (incoming instanceof Error) throw incoming;
    const failed = page.waitForEvent('requestfailed', { predicate: request => request.url() === pendingUrl, timeout: 2000 }).catch(error => error);
    await frame.evaluate(() => window.stop());
    const request = await failed; if (request instanceof Error) throw request;
    result.abortedError = request.failure()?.errorText;
    result.survivingFrameUrl = frame.url();
    const source = `${fixture.mediaOrigin}/media/after-aborted-frame.mp4`;
    await frame.locator('video').evaluate((element, url) => { element.src = url; element.load(); }, source);
    const until = hostNow() + 3000;
    while (hostNow() < until) {
      result.after = await getWorker().evaluate(oursSample, tabId);
      if (result.after.items.some(item => item.url === source && item.status === 'confirmed' && item.frameIds.some(id => id !== 0))) break;
      await wait(100);
    }
    result.survivingDocumentAccepted = result.after.items.some(item => item.url === source && item.status === 'confirmed' && item.frameIds.some(id => id !== 0));
    result.topSourcePreserved = result.after.items.some(item => item.url === `${fixture.mediaOrigin}/media/top.mp4`);
    result.status = result.abortedError?.includes('ERR_ABORTED') && result.survivingDocumentAccepted && result.topSourcePreserved ? 'pass' : 'fail';
  } catch (error) { result.setupLimitation = cleanError(error); }
  return result;
}

async function openPopup(worker, extensionId, expectedUrl, artifact, waitForRows = 0, tabId) {
  await worker.evaluate(async id => {
    const tab = id === undefined ? (await chrome.tabs.query({ active: true, currentWindow: true }))[0] : await chrome.tabs.get(id);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.action.openPopup({ windowId: tab.windowId });
  }, tabId);
  let target;
  for (let attempt = 0; attempt < 30 && !target; attempt++) {
    target = (await (await fetch(`${debugEndpoint}/json/list`)).json()).find(item => item.url === `chrome-extension://${extensionId}/popup/index.html`);
    if (!target) await wait(100);
  }
  if (!target) throw new Error('Actual action popup target unavailable after chrome.action.openPopup');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let serial = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => { const value = JSON.parse(data); if (value.id && pending.has(value.id)) { pending.get(value.id)(value); pending.delete(value.id); } };
  async function send(method, params = {}) {
    const id = ++serial;
    const response = new Promise(resolve => pending.set(id, resolve));
    socket.send(JSON.stringify({ id, method, params }));
    const answer = await Promise.race([response, wait(5000).then(() => { throw new Error(`Popup CDP timeout: ${method}`); })]);
    if (answer.error) throw new Error(JSON.stringify(answer.error));
    return answer.result;
  }
  try {
    let value;
    for (let attempt = 0; attempt < 30; attempt++) {
      const response = await send('Runtime.evaluate', { expression: `({text:document.body?.innerText,rows:document.querySelectorAll('article.media').length,context:document.querySelector('#results .context')?.innerText,status:document.querySelector('#status')?.innerText,viewport:{width:innerWidth,height:innerHeight,devicePixelRatio,bodyWidth:document.body?.getBoundingClientRect().width}})`, returnByValue: true });
      value = response.result.value;
      if (value?.context && value.rows >= waitForRows) break;
      await wait(100);
    }
    const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
    await writeFile(path.join(output, artifact), Buffer.from(screenshot.data, 'base64'));
    return { observedWallMs: hostNow(), ...value, expectedContextVisible: !!value?.context?.includes(expectedUrl), artifact, kind: 'Actual chrome.action popup' };
  } finally { await send('Page.close').catch(() => undefined); socket.close(); }
}

// This function executes inside the original worker. Only whitelisted result fields leave it.
function originalSample(tabId) {
  return chrome.storage.session.get('global_session_state').then(raw => {
    function decode(x) {
      if (!x || typeof x !== 'object') return x;
      if (Array.isArray(x)) return x.map(decode);
      const t = x.__serde_tag, v = x.__serde_val;
      if (t === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !['headers', 'sent_headers', 'jwt'].includes(k)).map(([k, z]) => [k, decode(z)]));
      if (t === 'map') return v.map(([k, z]) => ({ key: decode(k), value: decode(z) }));
      if (t === 'none') return null;
      if (['primitive', 'array', 'url', 'some', 'set'].includes(t)) return decode(v);
      return null;
    }
    const state = decode(raw.global_session_state);
    const tab = state?.discovered?.find(record => record.key === tabId)?.value;
    return { browserWallMs: Date.now(), tabId, tabUrl: tab?.meta?.url, items: (tab?.media ?? []).map(({ value: item }) => ({
      type: item.type, url: item.master_url ?? item.playlist?.[0]?.av?.video, discoveredAt: item.discovery_timestamp_ms,
      extension: item.extension, protected: item.has_drm, variants: (item.playlist ?? []).map(v => ({ url: v.av?.video,
        width: v.quality?.size?.width, height: v.quality?.size?.height, bandwidth: v.quality?.bitrate, audioId: v.audio_id })),
    })) };
  });
}

function oursSample(tabId) {
  return chrome.storage.session.get('detectionState').then(raw => {
    const state = raw.detectionState, tab = state?.tabs?.[tabId];
    return { browserWallMs: Date.now(), revision: state?.revision, tabId, tabUrl: tab?.url, epoch: tab?.epoch,
      errors: tab?.errors, items: Object.values(tab?.media ?? {}).map(item => ({ url: item.url, type: item.type, status: item.status,
        reason: item.reason, firstSeen: item.firstSeen, lastSeen: item.lastSeen, bytes: item.bytes, methods: item.methods,
        frameIds: item.frameIds, documentIds: item.documentIds, elementIds: item.elementIds, variants: item.variants,
        childUrls: item.childUrls, segmentUrls: item.segmentUrls, childManifests: item.childManifests, duration: item.duration,
        protected: item.protected, live: item.live })) };
  });
}

function assess(items, expected, ours) {
  const remote = items.filter(item => /^https?:/.test(item.url ?? ''));
  const confirmed = ours ? remote.filter(item => item.status === 'confirmed') : remote;
  return { groups: remote.length, confirmedGroups: confirmed.length, blobContexts: items.filter(item => item.type === 'blob').length,
    expectedMatched: expected.filter(url => confirmed.some(item => item.url === url)).length,
    missed: expected.filter(url => !confirmed.some(item => item.url === url)),
    unexpectedConfirmed: confirmed.filter(item => !expected.includes(item.url)).map(item => item.url),
    duplicatePrimaryUrls: confirmed.length - new Set(confirmed.map(item => item.url)).size };
}

await mkdir(output, { recursive: true });
const results = { authority: 'Independent Playwright/CDP read-only extension storage and public-page observations; not REA Evidence',
  startedAt: new Date().toISOString(), pollRequestedMs: POLL_MS, trialsRequested: trials, cases: [], errors: [],
  clockMapping: { hostWallMs: Date.now(), hostMonotonicMs: performance.now(), hostTimeOriginMs: performance.timeOrigin },
  timingDefinition: 'One monotonic host clock (performance.timeOrigin + performance.now) for navigation/action/response/poll/render observations. Epoch-shaped fields keep WallMs names for readability. Poll completion is an upper bound; no rendered latency is inferred from storage. Original discovery timestamps are supplemental browser-wall fields.',
  limitations: ['Single isolated browser profile contains both extensions. Original welcome tab remains outside case accounting.',
    'No original download, Force detection, cookie clearing or proprietary-source inspection.',
    'Default command performs three trials; local fixture media bytes are fetched CC0 samples, held only in memory.',
    'Broad host access and unpacked-extension launch flags are testing conditions, not added production permissions.'] };
let fixture, context;
try {
  if (!Number.isInteger(trials) || trials < 1 || trials > 10) throw new Error('--trials must be an integer from 1 through 10');
  if (!Number.isFinite(windowMs) || windowMs < 100 || windowMs > 10000) throw new Error('--window must be from 100 through 10000 milliseconds');
  fixture = await startFixtures();
  results.fixtures = { pageOrigin: fixture.pageOrigin, frameOrigin: fixture.frameOrigin, mediaOrigin: fixture.mediaOrigin, sampleSizes: fixture.sizes,
    mediaLicense: 'MDN CC0 flower samples', mediaSource: FLOWER_BASE, hlsOrderAssets: fixture.orderAssets };
  const profile = await mkdtemp(path.join(tmpdir(), 'media-detection-comparison-'));
  results.profileKind = 'New temporary isolated profile; existing 9222 profile untouched';
  results.build = { gitRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), files: {} };
  for (const file of ['background.js', 'content.js', 'popup/index.js', 'popup/index.html', 'popup/style.css', 'manifest.json']) results.build.files[file] = createHash('sha256').update(await readFile(path.join(oursPath, file))).digest('hex');
  context = await chromium.launchPersistentContext(profile, { executablePath: binary, headless: true, viewport: { width: 1000, height: 800 },
    args: [`--disable-extensions-except=${oursPath},${originalPath}`, `--load-extension=${oursPath},${originalPath}`, '--remote-debugging-port=0'] });
  const debuggingPort = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
  if (!Number.isInteger(debuggingPort) || debuggingPort < 1 || debuggingPort === 9222) throw new Error('Invalid isolated debugging port');
  debugEndpoint = `http://127.0.0.1:${debuggingPort}`;
  results.debuggingPort = debuggingPort;
  const workerErrors = [];
  const observeWorker = worker => worker.on('console', msg => { if (['error', 'warning'].includes(msg.type())) workerErrors.push({ worker: new URL(worker.url()).hostname, type: msg.type(), text: cleanError(msg.text()) }); });
  context.on('serviceworker', observeWorker);
  for (let attempt = 0; attempt < 50 && context.serviceWorkers().length < 2; attempt++) await wait(100);
  let ours = context.serviceWorkers().find(worker => !worker.url().includes(ORIGINAL_ID));
  const original = context.serviceWorkers().find(worker => worker.url().includes(ORIGINAL_ID));
  if (!ours || !original) throw new Error(`Both extension workers required: ${context.serviceWorkers().map(worker => worker.url()).join(', ')}`);
  context.serviceWorkers().forEach(observeWorker);
  const ourId = new URL(ours.url()).hostname;
  results.browser = context.browser()?.version();
  results.extensions = { original: { id: ORIGINAL_ID, version: JSON.parse(await readFile(path.join(originalPath, 'manifest.json'), 'utf8')).version },
    ours: { id: ourId, version: JSON.parse(await readFile(path.join(oursPath, 'manifest.json'), 'utf8')).version } };
  results.grantedPermissions = { ours: await ours.evaluate(async () => chrome.permissions.getAll()), original: await original.evaluate(async () => chrome.permissions.getAll()) };
  results.cacheConditions = 'New temporary profile starts cold. No cache/service-worker/cookie purge; subsequent cases and repeated fresh tabs may use warm HTTP caches.';
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await original.evaluate(async () => !!(await chrome.storage.session.get('global_session_state')).global_session_state)) break;
    await wait(100);
  }
  await wait(2000);
  const cases = [
    { id: 'direct-mp4', category: 'direct MP4', url: `${FLOWER_BASE}flower.mp4`, expected: [`${FLOWER_BASE}flower.mp4`] },
    { id: 'direct-webm', category: 'direct WebM', url: `${FLOWER_BASE}flower.webm`, expected: [`${FLOWER_BASE}flower.webm`] },
    { id: 'hls', category: 'HLS / qualities / MSE', url: 'https://hlsjs.video-dev.org/demo/basic-usage', expected: ['https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'], expectedVideoVariants: 5 },
    { id: 'dash', category: 'DASH / qualities / MSE', url: 'https://reference.dashif.org/dash.js/latest/samples/dash-if-reference-player/index.html', expected: ['https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd'], expectedVideoVariants: 10,
      action: async page => { await page.getByLabel('Muted', { exact: true }).waitFor({ state: 'attached', timeout: 10000 }); await wait(500); await page.locator('#btn-options').click({ timeout: 10000 }); await page.getByLabel('Muted', { exact: true }).check({ timeout: 5000 }); await page.locator('#btn-load').click({ timeout: 5000 }); } },
    { id: 'dynamic', category: 'JavaScript dynamic insertion', url: `${fixture.pageOrigin}/dynamic`, expected: [`${fixture.mediaOrigin}/media/dynamic.mp4`], action: page => page.getByRole('button', { name: 'Insert video' }).click() },
    { id: 'blob-mse', category: 'blob / MSE with remote MP4', url: 'https://mdn.github.io/dom-examples/sourcebuffer/', expected: ['https://mdn.github.io/dom-examples/sourcebuffer/frag_bunny.mp4'], action: page => page.getByRole('button', { name: 'Load', exact: true }).click({ timeout: 10000 }) },
    { id: 'cross-origin-frame', category: 'cross-origin iframe and third-origin media', url: `${fixture.pageOrigin}/embedded`, expected: [`${fixture.mediaOrigin}/media/framed.mp4`] },
    { id: 'multiple', category: 'multiple independent videos', url: `${fixture.pageOrigin}/multiple`, expected: [`${fixture.mediaOrigin}/media/first.mp4`, `${fixture.mediaOrigin}/media/second.webm`] },
    { id: 'no-video', category: 'no video negative', url: `${fixture.pageOrigin}/no-video`, expected: [] },
    { id: 'mime-negative', category: 'misleading .mp4 with HTML MIME', url: `${fixture.pageOrigin}/mime-negative`, expected: [] },
    { id: 'hls-master-only', category: 'master-only HLS live-state regression', regressionOnly: true, url: `${fixture.pageOrigin}/master-only`, expected: [`${fixture.pageOrigin}/master-only.m3u8`], expectedVideoVariants: 5, expectUnknownLive: true,
      action: page => page.getByRole('button', { name: 'Observe master' }).click() },
    ...[
      { id: 'hls-master-child', childFirst: false, protected: false },
      { id: 'hls-child-master-inflight', childFirst: true, protected: true },
      { id: 'hls-pending-child-restart', childFirst: false, protected: false, restart: true },
    ].map(settings => ({ id: settings.id, regressionOnly: true, prepare(trial) {
      const control = Object.assign(fixture.order(settings.id, trial, { hold: true, protected: settings.protected }), settings);
      return { id: settings.id, category: 'controlled HLS observed-child request order', url: control.page, expected: [control.master], expectedVideoVariants: 2,
        expectedOwnerStatus: settings.protected ? 'unsupported' : 'confirmed', orderedChild: true, action: (page, environment) => exerciseHlsOrder(page, control, environment) };
    } })),
  ];
  const selected = options.cases ? cases.filter(test => String(options.cases).split(',').includes(test.id)) : cases.filter(test => !test.regressionOnly);
  if (!selected.length) throw new Error('--cases did not select any known case');
  for (let trial = 1; trial <= trials; trial++) for (const definition of selected) {
    const test = definition.prepare ? definition.prepare(trial) : definition;
    const page = await context.newPage();
    await page.bringToFront();
    const tabId = await ours.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
    const result = { id: test.id, trial, category: test.category, url: test.url, expected: test.expected, expectedVideoVariants: test.expectedVideoVariants,
      tabId, startedAt: new Date().toISOString(), actions: test.action ? 'Navigate, then declared page button interaction' : 'Navigate only', errors: [], responses: [], changes: [] };
    results.cases.push(result);
    const t0 = hostNow();
    result.navigationCallWallMs = t0;
    page.on('pageerror', error => result.errors.push({ type: 'page', message: cleanError(error) }));
    page.on('requestfailed', request => { if (test.expected.includes(request.url())) result.errors.push({ type: 'expected-request', url: safeUrl(request.url()), message: request.failure()?.errorText }); });
    page.on('response', response => { if (test.expected.includes(response.url()) || /\.(?:m3u8|mpd)(?:\?|$)/i.test(response.url())) result.responses.push({ wallMs: hostNow(), url: safeUrl(response.url()), status: response.status() }); });
    let polling = true, suspended = false, evaluationInFlight = false, previous = '', samples = 0, intervals = [], lastPoll, pauseStarted;
    const pollPauses = [];
    const first = { oursCandidate: null, oursConfirmed: null, originalCandidate: null };
    const loop = (async () => {
      while (polling) {
        if (suspended) { await wait(25); continue; }
        const before = hostNow();
        if (lastPoll) intervals.push(before - lastPoll);
        lastPoll = before;
        evaluationInFlight = true;
        try {
          const [ourState, originalState] = await Promise.all([ours.evaluate(oursSample, tabId), original.evaluate(originalSample, tabId)]);
          const wallMs = hostNow(); samples++;
          const oursMatching = ourState.items.filter(item => test.expected.includes(item.url));
          if (oursMatching.length && first.oursCandidate === null) first.oursCandidate = wallMs;
          if (oursMatching.some(item => item.status === 'confirmed') && first.oursConfirmed === null) first.oursConfirmed = wallMs;
          if (originalState.items.some(item => test.expected.includes(item.url)) && first.originalCandidate === null) first.originalCandidate = wallMs;
          result.final = { ours: ourState, original: originalState };
          const signature = JSON.stringify([ourState.items, originalState.items]);
          if (signature !== previous) { result.changes.push({ wallMs, ours: ourState, original: originalState }); previous = signature; }
        } catch (error) { result.errors.push({ type: 'poll', message: cleanError(error) }); }
        finally { evaluationInFlight = false; }
        await wait(Math.max(0, POLL_MS - (hostNow() - before)));
      }
    })();
    try {
      const response = await page.goto(test.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      result.documentStatus = response?.status();
      if (test.action) {
        result.actionWallMs = hostNow();
        await test.action(page, { result, tabId, context, extensionId: ourId, getWorker: () => ours, replaceWorker: worker => { ours = worker; },
          pausePolling: async () => { suspended = true; pauseStarted = hostNow(); while (evaluationInFlight) await wait(10); },
          resumePolling: () => { pollPauses.push({ startedWallMs: pauseStarted, endedWallMs: hostNow(), reason: 'Actual pending-child worker stop/wake; no worker storage evaluations during stop' }); lastPoll = undefined; suspended = false; } });
        result.actionCompletedWallMs = hostNow();
      }
      const observeUntil = hostNow() + windowMs;
      while (hostNow() < observeUntil) await wait(100);
      result.dom = await Promise.all(page.frames().map(async frame => { try { return { frameUrl: safeUrl(frame.url()), media: await frame.locator('video,audio').evaluateAll(elements => elements.map(element => ({ currentSrc: element.currentSrc, src: element.getAttribute('src'), readyState: element.readyState, width: element.videoWidth, height: element.videoHeight, paused: element.paused, errorCode: element.error?.code ?? null }))) }; } catch (error) { return { frameUrl: safeUrl(frame.url()), error: cleanError(error) }; } }));
      await page.bringToFront();
      const popupStarted = hostNow();
      result.popup = { openedWallMs: popupStarted, ...await openPopup(ours, ourId, test.url, `${test.id}-${trial}-popup.png`, 0, tabId) };
    } catch (error) {
      result.errors.push({ type: error instanceof ExpectationError ? 'behavior' : 'setup-or-action', message: cleanError(error) });
      result.setupPage = { title: await page.title().catch(() => ''), url: safeUrl(page.url()), controls: await page.locator('button,label,a').evaluateAll(elements => elements.map(element => element.textContent?.trim()).filter(Boolean).slice(0, 150)).catch(() => []) };
      result.setupPage.inputs = await page.locator('input[type=checkbox]').evaluateAll(elements => elements.map(element => ({ id: element.id, name: element.name, labels: [...element.labels].map(label => label.textContent?.trim()), visible: !!element.getClientRects().length }))).catch(() => []);
      await page.screenshot({ path: path.join(output, `${test.id}-${trial}-setup.png`), fullPage: false }).catch(() => undefined);
    }
    finally { polling = false; await loop; }
    result.polling = { samples, requestedMs: POLL_MS, minIntervalMs: Math.min(...intervals), maxIntervalMs: Math.max(...intervals), deliberatePauses: pollPauses };
    result.timing = { firstCandidateAfterNavigationMs: first.oursCandidate === null ? null : first.oursCandidate - t0,
      firstConfirmedAfterNavigationMs: first.oursConfirmed === null ? null : first.oursConfirmed - t0,
      originalFirstAfterNavigationMs: first.originalCandidate === null ? null : first.originalCandidate - t0,
      firstExpectedResponseAfterNavigationMs: result.responses.find(response => test.expected.includes(response.url))?.wallMs - t0 || null,
      candidateAfterExpectedResponseMs: null, confirmedAfterExpectedResponseMs: null, originalAfterExpectedResponseMs: null,
      automaticRenderedRowLatencyMs: null };
    const responseTime = result.responses.find(response => test.expected.includes(response.url))?.wallMs;
    if (responseTime) for (const [key, field] of [['candidateAfterExpectedResponseMs', 'oursCandidate'], ['confirmedAfterExpectedResponseMs', 'oursConfirmed'], ['originalAfterExpectedResponseMs', 'originalCandidate']]) result.timing[key] = first[field] === null ? null : first[field] - responseTime;
    result.assessment = { ours: assess(result.final?.ours.items ?? [], test.expected, true), original: assess(result.final?.original.items ?? [], test.expected, false) };
    const videoVariants = result.final?.ours.items.find(item => test.expected.includes(item.url))?.variants.filter(variant => variant.kind === 'video').length;
    result.assessment.ours.videoVariants = videoVariants;
    if (test.expectUnknownLive) {
      const master = result.final?.ours.items.find(item => test.expected.includes(item.url));
      result.assessment.ours.liveStateUnknown = !!master && typeof master.live !== 'boolean';
      result.assessment.ours.popupOmitsLiveMode = !!result.popup && !result.popup.text.includes(' · Live') && !result.popup.text.includes(' · VOD');
    }
    const setupFailed = result.errors.some(error => error.type === 'setup-or-action') || result.documentStatus >= 400 || test.expected.length && !responseTime;
    const a = result.assessment.ours;
    const expectedOwner = result.final?.ours.items.find(item => test.expected.includes(item.url));
    if (test.orderedChild) { a.expectedOwnerStatus = test.expectedOwnerStatus; a.expectedOwnerPresent = !!expectedOwner; a.orderedMetadataPassed = result.order?.passed === true; }
    const expectedSourcesMatched = test.orderedChild ? a.groups === 1 && expectedOwner?.status === test.expectedOwnerStatus && result.order?.passed : a.expectedMatched === test.expected.length;
    result.status = setupFailed ? 'blocked' : !result.errors.some(error => error.type === 'behavior') && expectedSourcesMatched && !a.unexpectedConfirmed.length && !a.duplicatePrimaryUrls && (!test.expectedVideoVariants || videoVariants === test.expectedVideoVariants) && (!test.expectUnknownLive || a.liveStateUnknown && a.popupOmitsLiveMode) && result.popup?.expectedContextVisible ? 'pass' : 'fail';
    result.originalStatus = setupFailed ? 'blocked' : result.assessment.original.expectedMatched === test.expected.length && !result.assessment.original.unexpectedConfirmed.length && !result.assessment.original.duplicatePrimaryUrls ? 'pass' : 'fail';
    result.endedAt = new Date().toISOString();
    await writeFile(path.join(output, `${test.id}-${trial}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ case: test.id, trial, status: result.status, original: result.originalStatus, ours: a, timing: result.timing, errors: result.errors }));
    await page.close();
  }
  results.workerErrors = workerErrors;
  // Lifecycle test is deliberately separate from repeated storage polling, which attaches a debugger.
  if (!options['skip-lifecycle']) {
    const life = { status: 'blocked', steps: [], errors: [] };
    results.lifecycle = life;
    let page;
    try {
      page = await context.newPage(); await page.goto(`${fixture.pageOrigin}/direct`); await page.bringToFront();
      const tabId = await ours.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
      await wait(1500);
      life.before = await ours.evaluate(oursSample, tabId);
      const cdp = await context.newCDPSession(page);
      const versions = new Map();
      cdp.on('ServiceWorker.workerVersionUpdated', event => event.versions.forEach(version => versions.set(version.versionId, version)));
      await cdp.send('ServiceWorker.enable'); await wait(300);
      const version = [...versions.values()].find(version => version.scriptURL === `chrome-extension://${ourId}/background.js` && version.runningStatus === 'running');
      life.versionsBefore = [...versions.values()].filter(version => version.scriptURL.includes(ourId)).map(({ versionId, runningStatus, scriptURL }) => ({ versionId, runningStatus, scriptURL }));
      if (!version) throw new Error('CDP did not expose running extension ServiceWorker version');
      await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
      await wait(350);
      life.stopped = [...versions.values()].some(v => v.versionId === version.versionId && v.runningStatus === 'stopped');
      life.steps.push('CDP ServiceWorker.stopWorker invoked; no worker evaluation during stop interval');
      if (!life.stopped) throw new Error('No actual stopped worker event observed');
      // Loading a background extension page and sending its ordinary snapshot request wakes the worker.
      // A new extension page invokes chrome.action.openPopup, which sends the ordinary snapshot message.
      const wakePage = await context.newPage(); await page.bringToFront(); await wakePage.goto(`chrome-extension://${ourId}/popup/index.html`);
      await wakePage.evaluate(async id => chrome.runtime.sendMessage({ type: 'snapshot', tabId: id }), tabId);
      await wait(200);
      ours = context.serviceWorkers().find(worker => worker.url().includes(ourId));
      life.after = await ours.evaluate(oursSample, tabId);
      life.recovered = life.before.items.length > 0 && life.before.items.every(item => life.after.items.some(other => other.url === item.url && other.firstSeen === item.firstSeen));
      await wakePage.close(); await page.bringToFront();
      life.popup = await openPopup(ours, ourId, `${fixture.pageOrigin}/direct`, 'lifecycle-popup.png', 0, tabId);
      await page.goto(`${fixture.pageOrigin}/no-video`); await wait(1000);
      life.afterNavigation = await ours.evaluate(oursSample, tabId);
      life.navigationCleared = life.afterNavigation.items.length === 0 && life.afterNavigation.tabUrl === `${fixture.pageOrigin}/no-video`;
      await page.goto(`${fixture.pageOrigin}/frame-lifecycle`); await wait(1000);
      life.frameBefore = await ours.evaluate(oursSample, tabId);
      await page.locator('iframe').evaluate((element, url) => { element.src = url; }, `${fixture.frameOrigin}/no-video`); await wait(1000);
      life.frameAfter = await ours.evaluate(oursSample, tabId);
      life.frameNavigationCleared = life.frameBefore.items.some(item => item.url === `${fixture.mediaOrigin}/media/framed.mp4`)
        && !life.frameAfter.items.some(item => item.url === `${fixture.mediaOrigin}/media/framed.mp4`)
        && life.frameAfter.items.some(item => item.url === `${fixture.mediaOrigin}/media/top.mp4`);
      life.abortedFrame = await abortedFrameControl(page, fixture, () => ours, tabId);
      const other = await context.newPage(); await other.goto(`${fixture.pageOrigin}/direct`); await other.bringToFront();
      const otherTabId = await ours.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
      await page.goto(`${fixture.pageOrigin}/direct`); await wait(1000);
      life.concurrentBefore = { first: await ours.evaluate(oursSample, tabId), second: await ours.evaluate(oursSample, otherTabId) };
      await page.goto(`${fixture.pageOrigin}/no-video`); await wait(600);
      life.concurrentAfter = { first: await ours.evaluate(oursSample, tabId), second: await ours.evaluate(oursSample, otherTabId) };
      life.concurrentTabsIsolated = life.concurrentBefore.first.items.length === 1 && life.concurrentBefore.second.items.length === 1
        && life.concurrentAfter.first.items.length === 0 && life.concurrentAfter.second.items.length === 1;
      await other.close();
      await page.goto(`${fixture.pageOrigin}/stale-manifest`); await page.getByRole('button', { name: 'Observe manifest' }).click();
      for (let attempt = 0; attempt < 30; attempt++) {
        life.pendingBeforeNavigation = await ours.evaluate(oursSample, tabId);
        if (life.pendingBeforeNavigation.items.some(item => item.status === 'probing') && fixture.slowManifestRequests() >= 2) break;
        await wait(50);
      }
      life.pendingProbeObserved = life.pendingBeforeNavigation.items.some(item => item.status === 'probing') && fixture.slowManifestRequests() >= 2;
      await page.goto(`${fixture.pageOrigin}/no-video`); await wait(2000);
      life.staleAfter = await ours.evaluate(oursSample, tabId);
      life.staleCompletionRejected = life.pendingProbeObserved && life.staleAfter.items.length === 0;
      let popupMediaResponse;
      page.on('response', response => { if (response.url() === `${fixture.mediaOrigin}/media/popup.mp4` && !popupMediaResponse) popupMediaResponse = hostNow(); });
      await page.goto(`${fixture.pageOrigin}/popup-delayed`); await page.bringToFront();
      life.livePopup = await openPopup(ours, ourId, `${fixture.pageOrigin}/popup-delayed`, 'lifecycle-live-popup.png', 1, tabId);
      life.livePopup.expectedMediaResponseWallMs = popupMediaResponse ?? null;
      life.livePopup.renderedAfterResponseMs = popupMediaResponse ? life.livePopup.observedWallMs - popupMediaResponse : null;
      life.livePopup.expectedSourceVisible = life.livePopup.text.includes(`${fixture.mediaOrigin}/media/popup.mp4`);
      life.livePopup.renderedWithinTwoSeconds = life.livePopup.rows === 1 && life.livePopup.expectedSourceVisible && life.livePopup.renderedAfterResponseMs >= 0 && life.livePopup.renderedAfterResponseMs <= 2000;
      life.status = life.stopped && life.recovered && life.navigationCleared && life.frameNavigationCleared && life.abortedFrame.status !== 'fail' && life.concurrentTabsIsolated && life.staleCompletionRejected && life.livePopup.renderedWithinTwoSeconds ? 'pass' : 'fail';
      await cdp.detach();
    } catch (error) { life.errors.push(cleanError(error)); }
    finally { if (page) await page.close(); }
    console.log(JSON.stringify({ lifecycle: life.status, stopped: life.stopped, recovered: life.recovered, navigationCleared: life.navigationCleared, frameNavigationCleared: life.frameNavigationCleared, abortedFrame: life.abortedFrame?.status, concurrentTabsIsolated: life.concurrentTabsIsolated, staleCompletionRejected: life.staleCompletionRejected, errors: life.errors }));
  }
} catch (error) { results.errors.push(cleanError(error)); process.exitCode = 1; }
finally {
  results.endedAt = new Date().toISOString();
  if (results.errors.length || results.cases.some(test => test.status === 'fail') || results.lifecycle?.status === 'fail') process.exitCode = 1;
  else if (results.cases.some(test => test.status === 'blocked') || results.lifecycle?.status === 'blocked') process.exitCode = 2;
  await writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  if (context) await context.close();
  if (fixture) await fixture.close();
}
