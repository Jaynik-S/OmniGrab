// Native browser controls for the page-context manifest repair. These local manifests
// exercise discovery and parsing only; they contain no playable media or decryption keys.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const options = Object.fromEntries(process.argv.slice(2).map(argument => {
  const [key, ...value] = argument.replace(/^--/, '').split('=');
  return [key, value.join('=')];
}));
const runName = `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const output = path.resolve(options.output || `docs/rea-evidence/cinejoy-gap/native-context/${runName}`);
const extensionPath = path.resolve('dist');
const binary = process.env.CHROMIUM_PATH ?? path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1243/chrome-win64/chrome.exe');
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
// Server request timestamps and harness observations share this monotonic host clock.
const now = () => performance.timeOrigin + performance.now();
const errorText = error => String(error?.stack ?? error).slice(0, 6_000);

const report = {
  startedAt: new Date().toISOString(),
  authority: 'Native Chromium with only the local unpacked extension; independent HTTP server receipts and read-only extension storage observations. Not REA Evidence.',
  playbackClaim: false,
  fixtureScope: 'Original local structural HLS manifests with an image/jpeg MIME type and image-suffixed renditions. No media bytes, protection keys, third-party requests, or proprietary source.',
  timingDefinition: 'performance.timeOrigin + performance.now() in this Node process for server headers/body/response-close events and harness actions. Deadline measurement starts when the server receives the matching primary GET, with a 500 ms native scheduling allowance.',
  clockMapping: { hostWallMs: Date.now(), hostMonotonicMs: performance.now(), hostTimeOriginMs: performance.timeOrigin },
  cases: [], requests: [], browserRequests: [], workerMessages: [], errors: [],
};

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
}

async function startFixtures() {
  const state = { recoveryAvailable: false };
  const timers = new Set();
  const sockets = new Set();
  const metrics = { activePageGets: 0, maximumActivePageGets: 0, byScenario: {} };
  let pageOrigin, mediaOrigin;
  const later = (callback, delay) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
    timers.add(timer);
    return timer;
  };
  const masterBody = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"\n1080.jpg\n#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"\n720.jpg\n';
  const mediaBody = '#EXTM3U\n#EXT-X-TARGETDURATION:3190\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:3189.56,\nvideo-001.ts\n#EXT-X-ENDLIST\n';
  const media = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://fixture.invalid').pathname;
    const scenario = pathname.split('/')[1];
    const pageContext = request.method === 'GET' && request.headers.referer?.startsWith(`${pageOrigin}/`) === true;
    const entry = {
      sequence: report.requests.length + 1, scenario, method: request.method, pathname,
      url: `${mediaOrigin}${request.url}`, startedAtMs: now(),
      origin: request.headers.origin ?? null, referer: request.headers.referer ?? null,
      fetchSite: request.headers['sec-fetch-site'] ?? null,
      classification: request.method === 'POST' ? 'page-observation' : pageContext ? 'page-context-GET' : 'GET-without-page-referer',
    };
    report.requests.push(entry);
    if (pageContext) {
      const scenarioMetrics = metrics.byScenario[scenario] ??= { active: 0, maximum: 0 };
      scenarioMetrics.active++;
      scenarioMetrics.maximum = Math.max(scenarioMetrics.maximum, scenarioMetrics.active);
      metrics.activePageGets++;
      metrics.maximumActivePageGets = Math.max(metrics.maximumActivePageGets, metrics.activePageGets);
    }
    response.on('finish', () => { entry.finishedAtMs = now(); });
    response.on('close', () => {
      entry.closedAtMs = now();
      entry.closedBeforeFinish = !response.writableFinished;
      if (pageContext) { metrics.activePageGets--; metrics.byScenario[scenario].active--; }
    });
    request.on('aborted', () => { entry.requestAbortedAtMs = now(); });
    const headers = {
      'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS',
      'cache-control': 'no-store', 'content-type': 'image/jpeg',
    };
    const send = (status, body, bodyDelay = 0, mime = 'image/jpeg') => {
      if (response.destroyed) return;
      entry.status = status;
      response.writeHead(status, { ...headers, 'content-type': mime });
      response.flushHeaders();
      entry.headersSentAtMs = now();
      if (bodyDelay) {
        entry.bodyEndPlannedAtMs = now() + bodyDelay;
        const timer = later(() => { if (!response.destroyed) response.end(body); }, bodyDelay);
        response.once('close', () => { clearTimeout(timer); timers.delete(timer); });
      } else response.end(body);
    };
    if (request.method === 'OPTIONS') { send(204); return; }
    if (request.method === 'POST' && pathname.endsWith('.m3u8')) {
      request.resume();
      // This ordinary page request creates the observation. Only GETs are probes.
      send(200, 'Observed candidate; this POST is not a playlist response.', 0, 'application/octet-stream');
      return;
    }
    if (request.method !== 'GET') { send(405, 'Method not supported'); return; }
    if (scenario === 'deadline' && /^\/deadline\/candidate-[0-4]\.m3u8$/.test(pathname)) {
      if (pageContext) send(200, mediaBody, 3_000);
      else {
        entry.primaryDelayMs = 4_100;
        const timer = later(() => send(404, 'Primary context unavailable'), 4_100);
        response.once('close', () => { clearTimeout(timer); timers.delete(timer); });
      }
      return;
    }
    if (!['context', 'recovery'].includes(scenario)) { send(404, 'Unknown fixture'); return; }
    if (!pageContext || scenario === 'recovery' && !state.recoveryAvailable) { send(404, 'Not available in this request context'); return; }
    if (pathname.endsWith('/master.m3u8')) { send(200, masterBody); return; }
    if (pathname.endsWith('/1080.jpg') || pathname.endsWith('/720.jpg')) { send(200, mediaBody); return; }
    // Segments/keys are never needed to inspect a manifest. Any such request is recorded.
    send(410, 'No media or key bytes exist in this structural fixture');
  });
  const pages = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end('<!doctype html><html><head><meta name="referrer" content="origin"><title>Context-only HLS fixture</title></head><body><h1>Context-only HLS fixture</h1><p>Structural manifest discovery control. No playback or media download.</p></body></html>');
  });
  for (const server of [media, pages]) server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  try {
    await listen(pages); pageOrigin = `http://127.0.0.1:${pages.address().port}`;
    await listen(media); mediaOrigin = `http://127.0.0.1:${media.address().port}`;
  } catch (error) { pages.close(); media.close(); throw error; }
  return {
    pageOrigin, mediaOrigin, state, metrics,
    async close() {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await Promise.all([media, pages].map(server => new Promise(resolve => server.close(resolve))));
    },
  };
}

function sampleState(tabId) {
  return chrome.storage.session.get('detectionState').then(raw => {
    const snapshot = raw.detectionState, tab = snapshot?.tabs?.[tabId];
    return { observedBrowserWallMs: Date.now(), revision: snapshot?.revision, tabId, epoch: tab?.epoch,
      tabUrl: tab?.url, errors: tab?.errors, items: Object.values(tab?.media ?? {}).map(item => ({
        url: item.url, type: item.type, status: item.status, reason: item.reason,
        methods: item.methods, frameIds: item.frameIds, documentIds: item.documentIds,
        firstSeen: item.firstSeen, lastSeen: item.lastSeen, probeAttempts: item.probeAttempts,
        duration: item.duration, variants: item.variants, childUrls: item.childUrls,
        childManifests: item.childManifests, segmentUrls: item.segmentUrls,
      })) };
  });
}

async function stateUntil(worker, tabId, predicate, label, result, timeoutMs = 8_000) {
  const until = now() + timeoutMs;
  let lastSignature;
  while (now() < until) {
    const state = await worker.evaluate(sampleState, tabId);
    const signature = JSON.stringify(state.items);
    if (signature !== lastSignature) { result.states.push({ observedAtMs: now(), label, state }); lastSignature = signature; }
    if (predicate(state)) return state;
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function observeCandidates(page, sources) {
  return page.evaluate(async urls => Promise.all(urls.map(async url => {
    const response = await fetch(url, { method: 'POST', credentials: 'omit', signal: AbortSignal.timeout(3_000) });
    await response.arrayBuffer();
    return { url, status: response.status };
  })), sources);
}

async function connectPopup(worker, extensionId, tabId, debugEndpoint) {
  await worker.evaluate(async id => {
    const tab = await chrome.tabs.get(id);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(id, { active: true });
    await chrome.action.openPopup({ windowId: tab.windowId });
  }, tabId);
  let target;
  for (let attempt = 0; attempt < 30 && !target; attempt++) {
    const targets = await (await fetch(`${debugEndpoint}/json/list`)).json();
    target = targets.find(value => value.url === `chrome-extension://${extensionId}/popup/index.html`);
    if (!target) await wait(100);
  }
  if (!target) throw new Error('Actual chrome.action popup target unavailable');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let serial = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const value = JSON.parse(data);
    const request = pending.get(value.id);
    if (!request) return;
    pending.delete(value.id); clearTimeout(request.timer);
    if (value.error) request.reject(new Error(JSON.stringify(value.error)));
    else request.resolve(value.result);
  };
  socket.onclose = () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Popup target closed')); }
    pending.clear();
  };
  function send(method, params = {}) {
    const id = ++serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Popup CDP timeout: ${method}`)); }, 5_000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  const popupSample = () => ({
    text: document.body?.innerText,
    primary: [...document.querySelectorAll('.primary-media article')].map(article => article.innerText),
    evidenceOpen: document.querySelector('.secondary-evidence')?.open ?? null,
    status: document.querySelector('#status')?.innerText,
    rescanDisabled: document.querySelector('#rescan')?.disabled,
  });
  return {
    kind: 'Actual toolbar action popup opened with chrome.action.openPopup',
    async sample() {
      const response = await send('Runtime.evaluate', { expression: `(${popupSample.toString()})()`, returnByValue: true });
      if (response.exceptionDetails) throw new Error('Popup sample evaluation failed');
      return response.result.value;
    },
    async rescan() {
      const response = await send('Runtime.evaluate', { expression: 'document.querySelector("#rescan").click()', returnByValue: true });
      if (response.exceptionDetails) throw new Error('Actual popup Rescan click failed');
    },
    async screenshot(name) {
      const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
      await writeFile(path.join(output, name), Buffer.from(screenshot.data, 'base64'));
      return name;
    },
    async close() { await send('Page.close').catch(() => undefined); socket.close(); },
  };
}

async function popupUntil(popup, predicate, label) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const value = await popup.sample();
    if (predicate(value)) return value;
    await wait(100);
  }
  throw new Error(`Actual popup did not show ${label}`);
}

function assertEnriched(state, master) {
  const remote = state.items.filter(item => /^https?:/.test(item.url));
  assert.equal(remote.length, 1, 'one master owns its renditions; no separate segment rows');
  const item = remote[0];
  assert.equal(item.url, master);
  assert.equal(item.type, 'hls');
  assert.equal(item.status, 'confirmed');
  assert.ok(Math.abs(item.duration - 3189.56) < 0.001, 'media EXTINF duration must enrich the master');
  assert.deepEqual(item.variants.filter(variant => variant.kind === 'video').map(variant => variant.height).sort((a, b) => b - a), [1080, 720]);
  assert.ok(item.childManifests?.some(child => child.url.endsWith('/1080.jpg') && child.status === 'confirmed'));
  return item;
}

function assertContextRequests(scenario, fixture) {
  const entries = report.requests.filter(request => request.scenario === scenario);
  const worker = entries.filter(request => request.method === 'GET' && request.classification === 'GET-without-page-referer');
  const content = entries.filter(request => request.classification === 'page-context-GET');
  assert.ok(worker.some(request => request.pathname.endsWith('/master.m3u8') && request.status === 404));
  assert.ok(worker.every(request => report.browserRequests.some(observation => observation.method === 'GET' &&
    observation.url === request.url && observation.serviceWorker === `chrome-extension://${report.extension.id}/background.js`)),
  'primary GET attribution must identify this extension worker');
  assert.ok(content.some(request => request.pathname.endsWith('/master.m3u8') && request.status === 200 && request.origin === fixture.pageOrigin));
  assert.ok(content.some(request => request.pathname.endsWith('/1080.jpg') && request.status === 200));
  assert.ok(!entries.some(request => request.pathname.endsWith('/720.jpg')), 'unused 720p rendition must not be fetched');
  assert.ok(!entries.some(request => /\.(?:ts|mp4|m4s|key)$/.test(request.pathname)), 'discovery must not fetch media segments or keys');
  return { worker404: worker.length, pageContextRequests: content.length, noUnusedRendition: true, noSegmentsOrKeys: true };
}

await mkdir(path.dirname(output), { recursive: true });
// A run directory must be new so reruns preserve earlier evidence, including failures.
await mkdir(output);
let fixture, context;
try {
  fixture = await startFixtures();
  report.fixtures = { pageOrigin: fixture.pageOrigin, mediaOrigin: fixture.mediaOrigin,
    mime: 'image/jpeg', cors: 'Access-Control-Allow-Origin: *; no credential allowance',
    primaryGetDelayMs: 4_100, pageBodyStallMs: 3_000, sharedProbeDeadlineMs: 5_000, nativeDeadlineAllowanceMs: 500 };
  const profile = await mkdtemp(path.join(tmpdir(), 'cinejoy-context-native-'));
  report.profile = { directory: profile, kind: 'New temporary owned profile. Existing user profiles and debugging port 9222 are untouched.' };
  report.build = { gitRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), files: {} };
  for (const file of ['manifest.json', 'background.js', 'content.js', 'popup/index.js', 'popup/index.html', 'popup/style.css']) {
    report.build.files[file] = createHash('sha256').update(await readFile(path.join(extensionPath, file))).digest('hex');
  }
  context = await chromium.launchPersistentContext(profile, {
    executablePath: binary, headless: true, viewport: { width: 1_000, height: 800 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--remote-debugging-port=0'],
  });
  report.browser = context.browser()?.version();
  const debuggingPort = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
  assert.ok(Number.isInteger(debuggingPort) && debuggingPort > 0 && debuggingPort !== 9222, 'owned random debugging port required');
  report.debuggingPort = debuggingPort;
  const debugEndpoint = `http://127.0.0.1:${debuggingPort}`;
  let worker;
  for (let attempt = 0; attempt < 50 && !worker; attempt++) {
    worker = context.serviceWorkers().find(value => value.url().startsWith('chrome-extension://') && value.url().endsWith('/background.js'));
    if (!worker) await wait(100);
  }
  assert.ok(worker, 'local extension worker required');
  const extensionId = new URL(worker.url()).hostname;
  report.extension = { id: extensionId, manifest: JSON.parse(await readFile(path.join(extensionPath, 'manifest.json'), 'utf8')) };
  worker.on('console', message => report.workerMessages.push({ atMs: now(), type: message.type(), text: message.text().slice(0, 2_000) }));
  context.on('request', request => {
    if (!request.url().startsWith(fixture.mediaOrigin)) return;
    report.browserRequests.push({ atMs: now(), method: request.method(), url: request.url(),
      serviceWorker: request.serviceWorker()?.url() ?? null });
  });

  for (const scenario of ['context', 'recovery', 'deadline']) {
    const result = { id: scenario, startedAtMs: now(), status: 'running', states: [] };
    report.cases.push(result);
    const page = await context.newPage();
    let popup;
    try {
      const pageUrl = `${fixture.pageOrigin}/${scenario}`;
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
      await page.bringToFront();
      const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, pageUrl);
      assert.ok(Number.isInteger(tabId), 'exact fixture tab required');
      result.tabId = tabId; result.pageUrl = pageUrl;
      if (scenario !== 'deadline') {
        const master = `${fixture.mediaOrigin}/${scenario}/master.m3u8`;
        result.observations = await observeCandidates(page, [master]);
        assert.deepEqual(result.observations.map(value => value.status), [200]);
        let before;
        if (scenario === 'recovery') {
          before = await stateUntil(worker, tabId, state => state.items.some(item => item.url === master && item.status === 'unresolved'), 'initial both-context 404 failure', result);
          const failed = before.items.find(item => item.url === master);
          assert.match(failed.reason, /404/);
          const initialRequests = report.requests.filter(request => request.scenario === scenario && request.method === 'GET');
          assert.ok(initialRequests.some(request => request.classification === 'GET-without-page-referer' && request.status === 404));
          assert.ok(initialRequests.some(request => request.classification === 'page-context-GET' && request.status === 404),
            'the initially unavailable source must fail through both actual request contexts');
          result.initialFailure = before;
          popup = await connectPopup(worker, extensionId, tabId, debugEndpoint);
          result.initialPopup = await popupUntil(popup, value => value.text?.includes('404') && value.primary.length === 0, 'failed HLS evidence');
          assert.equal(result.initialPopup.evidenceOpen, true);
          result.initialPopupScreenshot = await popup.screenshot('recovery-before-rescan.png');
          fixture.state.recoveryAvailable = true;
          result.serverAvailableAtMs = now();
          result.rescanClickedAtMs = now();
          await popup.rescan();
        }
        const final = await stateUntil(worker, tabId, state => state.items.some(item => item.url === master && item.status === 'confirmed' && Math.abs(item.duration - 3189.56) < 0.001), 'one enriched confirmed HLS source', result);
        const source = assertEnriched(final, master);
        if (before) {
          assert.equal(final.epoch, before.epoch, 'Rescan recovery must preserve the document generation');
          assert.equal(source.firstSeen, before.items.find(item => item.url === master).firstSeen, 'retry must preserve source identity');
        }
        popup ??= await connectPopup(worker, extensionId, tabId, debugEndpoint);
        result.popup = await popupUntil(popup, value => value.primary.length === 1 && value.primary[0].includes('53:10') && value.primary[0].includes('1080p') && value.primary[0].includes('720p'), '53:10 HLS and two qualities');
        assert.match(result.popup.primary[0], /Source protocol: HLS/);
        assert.doesNotMatch(result.popup.primary[0], /downloadable MP4|Cinejoy\.mp4/i);
        result.popupScreenshot = await popup.screenshot(`${scenario}-confirmed.png`);
        await wait(250);
        result.assessment = assertContextRequests(scenario, fixture);
        result.final = final;
      } else {
        const masters = Array.from({ length: 5 }, (_, index) => `${fixture.mediaOrigin}/deadline/candidate-${index}.m3u8`);
        result.observations = await observeCandidates(page, masters);
        assert.ok(result.observations.every(value => value.status === 200));
        const overallDeadline = now() + 20_000;
        let previous = '', final, complete = false;
        while (now() < overallDeadline) {
          final = await worker.evaluate(sampleState, tabId);
          const signature = JSON.stringify(final.items);
          if (signature !== previous) { result.states.push({ observedAtMs: now(), state: final }); previous = signature; }
          assert.ok(!final.items.some(item => item.status === 'confirmed'), 'stalled fallback must never produce a confirmed source');
          const fallback = report.requests.filter(request => request.scenario === 'deadline' && request.classification === 'page-context-GET');
          // Remain alive past every originally planned body completion to catch late results.
          if (fallback.length === 5 && fallback.every(request => request.closedAtMs) &&
              now() > Math.max(...fallback.map(request => request.bodyEndPlannedAtMs)) + 300 &&
              final.items.length === 5 && final.items.every(item => item.status === 'unresolved')) { complete = true; break; }
          await wait(100);
        }
        assert.ok(complete, 'all five physical page requests must close and remain unresolved past delayed body completion');
        const entries = report.requests.filter(request => request.scenario === 'deadline');
        const primary = entries.filter(request => request.method === 'GET' && request.classification === 'GET-without-page-referer');
        const fallback = entries.filter(request => request.classification === 'page-context-GET');
        assert.equal(primary.length, 5, 'each candidate gets one primary extension request');
        assert.ok(primary.every(request => request.status === 404));
        assert.equal(fallback.length, 5, 'each candidate reaches a normal page-context fallback');
        result.deadlines = fallback.map(request => {
          const initial = primary.find(value => value.pathname === request.pathname && value.startedAtMs <= request.startedAtMs);
          assert.ok(initial, 'page fallback must follow the matching worker probe');
          return { url: request.url, primaryStartedAtMs: initial.startedAtMs, fallbackStartedAtMs: request.startedAtMs,
            headersSentAtMs: request.headersSentAtMs, plannedBodyEndAtMs: request.bodyEndPlannedAtMs,
            closedAtMs: request.closedAtMs, closedBeforeFinish: request.closedBeforeFinish,
            elapsedFromPrimaryStartMs: request.closedAtMs - initial.startedAtMs };
        });
        for (const evidence of result.deadlines) {
          assert.equal(evidence.closedBeforeFinish, true, 'native page response must be physically canceled before its delayed body finishes');
          assert.ok(evidence.elapsedFromPrimaryStartMs <= 5_500, `shared deadline exceeded: ${evidence.elapsedFromPrimaryStartMs} ms`);
        }
        const maximum = fixture.metrics.byScenario.deadline?.maximum ?? 0;
        assert.ok(maximum > 0 && maximum <= 4, `physical page fallback concurrency exceeded four: ${maximum}`);
        assert.ok(final.items.every(item => /timeout|aborted/i.test(item.reason ?? '')), 'deadline failure must remain explicit');
        result.assessment = { candidates: 5, physicalFallbacks: fallback.length, maximumActivePageFallbacks: maximum,
          allPhysicallyCanceledWithinSharedDeadline: true, noLateConfirmation: true };
        result.final = final;
      }
      result.status = 'pass';
    } catch (error) {
      result.status = 'fail'; result.error = errorText(error);
      await page.screenshot({ path: path.join(output, `${scenario}-failure-page.png`) }).catch(() => undefined);
    } finally {
      await popup?.close();
      await page.close();
      result.endedAtMs = now();
      result.serverRequests = report.requests.filter(request => request.scenario === scenario);
      console.log(`${scenario}: ${result.status}${result.error ? ` — ${result.error.split('\n')[0]}` : ''}`);
    }
  }
  report.metrics = fixture.metrics;
  report.passed = report.cases.length === 3 && report.cases.every(result => result.status === 'pass');
} catch (error) {
  report.errors.push(errorText(error)); report.passed = false;
} finally {
  // Close only the browser created above; never attach to or terminate the user's Chrome.
  await context?.close().then(() => { report.ownedBrowserClosed = true; }, error => { report.errors.push(errorText(error)); report.passed = false; });
  await fixture?.close();
  report.endedAt = new Date().toISOString();
  await writeFile(path.join(output, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output, passed: report.passed, cases: report.cases.map(({ id, status }) => ({ id, status })), ownedBrowserClosed: report.ownedBrowserClosed }, null, 2));
}
if (!report.passed) process.exitCode = 1;
