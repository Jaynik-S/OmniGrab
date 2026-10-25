// Full real-page acceptance. Loads dist unchanged; records metadata only, never media bodies.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { connectTarget } from './download-browser-cdp.mjs';

const target = 'https://cinejoy.pk/watch/tv/67178/2/1';
const selection720=process.argv.includes('--selection-720'),quality=selection720?'720p':'1080p',filename=`cinejoy-${quality}.mp4`;
const output = path.resolve(process.env.DOWNLOAD_ACCEPTANCE_OUTPUT ?? '.superpowers/download-acceptance');
const run = path.join(output, `live-${Date.now()}-${process.pid}`);
await mkdir(run, { recursive: true });
const report = { started: new Date().toISOString(), target, output, run, pid: process.pid, errors: [], samples: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function hashes(directory, prefix = '') {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name, file = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await hashes(file, name + '/'));
    else result[name] = createHash('sha256').update(await readFile(file)).digest('hex');
  }
  return result;
}
async function until(fn, predicate, label, timeout = 90000) {
  const end = Date.now() + timeout; let value;
  while (Date.now() < end) { value = await fn(); if (predicate(value)) return value; await delay(250); }
  throw Error(`${label}: ${JSON.stringify(value)}`);
}
const sockets = new Set();
const connect = (port, url) => connectTarget(port, url, sockets);
let context, page, popup, observer, observerExit;
const network = new Map(); let active = 0, maximumActive = 0, networkStarted = false;
let journal = Promise.resolve();
function journalEvent(event, record) {
  const { url, ...metadata } = record;
  const line = { event, at:new Date().toISOString(), ...metadata, ...(url ? { urlSha256:createHash('sha256').update(url).digest('hex') } : {}) };
  journal=journal.then(()=>appendFile(path.join(run,'network.ndjson'),JSON.stringify(line)+'\n')).catch(error=>{report.errors.push('Network journal write failed: '+error.message);});
}
function networkSummary() {
  const entries=[...network.values()],successful=entries.filter(r=>r.finished&&!r.error&&r.status>=200&&r.status<300);
  return { requests:entries.length, distinctUrls:new Set(entries.map(r=>r.url)).size,
    successfulBodyBytes:successful.reduce((n,r)=>n+Number(r.length||0),0),
    encodedBytes:successful.reduce((n,r)=>n+(r.encodedBytes||0),0),
    rangeSizes:[...new Set(entries.map(r=>r.range).filter(Boolean).map(r=>{const match=/bytes=(\d+)-(\d+)/.exec(r);return match?Number(match[2])-Number(match[1])+1:null;}))],maximumActive };
}
async function save() { report.networkSummary=networkSummary(); await writeFile(path.join(run, 'receipt.json'), JSON.stringify(report, null, 2)); }
function observeNetwork(connection,scope) {
  connection.on('Network.requestWillBeSent', ({ requestId, request, timestamp }) => {
    if (!networkStarted || !request.url.includes('/hls/')) return;
    const key=scope+':'+requestId,record = { requestId:key, scope, url: request.url, range: request.headers.Range ?? request.headers.range, started: timestamp };
    network.set(key, record); active++; maximumActive = Math.max(active, maximumActive);journalEvent('request',record);
  });
  connection.on('Network.responseReceived', ({ requestId, response }) => {
    const record = network.get(scope+':'+requestId); if (!record) return;
    const header = name => Object.entries(response.headers).find(([key]) => key.toLowerCase() === name)?.[1];
    Object.assign(record, { status: response.status, length: header('content-length'), contentRange: header('content-range'), mime: response.mimeType,fromDiskCache:response.fromDiskCache,fromServiceWorker:response.fromServiceWorker });journalEvent('response',record);
  });
  const finished = (event, error) => { const record = network.get(scope+':'+event.requestId); if (!record || record.finished) return; active--; Object.assign(record, { finished: event.timestamp, encodedBytes: event.encodedDataLength, error });journalEvent('finished',record); };
  connection.on('Network.loadingFinished', event => finished(event));connection.on('Network.loadingFailed', event => finished(event,event.errorText));
}
try {
  report.artifactBefore = await hashes(path.resolve('dist')); assert.equal(Object.keys(report.artifactBefore).length, 11);
  report.profile = await mkdtemp(path.join(tmpdir(), 'owned-cinejoy-download-'));
  await mkdir(path.join(report.profile, 'Default'), { recursive: true });
  await writeFile(path.join(report.profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: output, prompt_for_download: false, directory_upgrade: true } }));
  const extension = path.resolve('dist');
  context = await chromium.launchPersistentContext(report.profile, { executablePath: process.env.CHROMIUM_PATH ?? 'C:/Users/jay03/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe', headless: true, acceptDownloads: false, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--remote-debugging-port=0'] });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  report.extensionId = new URL(worker.url()).hostname;
  report.port = Number((await readFile(path.join(report.profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); assert.notEqual(report.port, 9222);
  page = await context.newPage();
  const cdp = await context.newCDPSession(page); await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
  await cdp.send('Network.enable', { maxTotalBufferSize: 2097152, maxResourceBufferSize: 2097152 });
  observeNetwork(cdp,'page');
  const host=await connect(report.port,`chrome-extension://${report.extensionId}/offscreen.html`);
  await host.send('Network.enable',{maxTotalBufferSize:2097152,maxResourceBufferSize:2097152});observeNetwork(host,'offscreen');report.networkScope='page-and-offscreen';
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.bringToFront();
  // Use the real detector: the site clears Resource Timing entries during playback.
  const popupUrl = `chrome-extension://${report.extensionId}/popup/index.html`;
  const boot = await connect(report.port, worker.url()); await boot.evaluate(() => chrome.action.openPopup()); boot.close();
  popup = await connect(report.port, popupUrl);
  report.controls = await until(() => popup.evaluate(() => [...document.querySelectorAll('.primary-media article')].map(a => ({ text: a.textContent, options: [...a.querySelectorAll('select option')].map(o => o.textContent), enabled: !a.querySelector('.download-start')?.disabled }))), rows => rows.some(r => r.options.includes('1080p') && r.enabled), 'download controls');
  report.pausedPlayers = await page.evaluate(() => { document.addEventListener('play', event => { if (event.target instanceof HTMLMediaElement) event.target.pause(); }, true); return [...document.querySelectorAll('video')].map(v => { v.pause(); return { currentTime: v.currentTime, paused: v.paused }; }); });
  const masterUrl = await popup.evaluate(async target => {
    const state = (await chrome.storage.session.get('detectionState')).detectionState;
    const tab = Object.values(state.tabs).find(tab => tab.url === target);
    return Object.values(tab.media).find(media => media.type === 'hls' && media.status === 'confirmed' && media.url.includes('master.m3u8')).url;
  }, target);
  report.selectedManifests = await page.evaluate(async ({url,quality}) => {
    const read = async url => { const r=await fetch(url,{signal:AbortSignal.timeout(15000)}),reader=r.body.getReader(),decoder=new TextDecoder();let bytes=0,text='';try{for(;;){const p=await reader.read();if(p.done)break;bytes+=p.value.length;if(bytes>2097152)throw Error('manifest too large');text+=decoder.decode(p.value,{stream:true});}text+=decoder.decode();return{url:r.url,status:r.status,text};}finally{await reader.cancel().catch(()=>{});reader.releaseLock();} };
    const resolution=quality==='720p'?'1280x720':'1920x1080';
    const master = await read(url), lines=master.text.split(/\r?\n/), index=lines.findIndex(line=>line.startsWith('#EXT-X-STREAM-INF:')&&new RegExp('RESOLUTION='+resolution+'(?:,|$)').test(line));
    if(index<0)throw Error('actual selected manifest missing');const childUrl=new URL(lines[index+1],master.url).href;
    return { master, selected: await read(childUrl) };
  }, {url:masterUrl,quality});
  assert.equal([...report.selectedManifests.selected.text.matchAll(/^#EXTINF:/gm)].length, 797);
  await writeFile(path.join(run, 'manifests.json'), JSON.stringify(report.selectedManifests, null, 2));
  await save();
  observer=spawn(process.execPath,['tests/download-acceptance-observe.mjs',run],{stdio:['ignore','ignore','inherit'],windowsHide:true});
  report.observerPid=observer.pid;observerExit=new Promise(resolve=>{observer.once('exit',(code,signal)=>resolve({code,signal}));observer.once('error',error=>resolve({error:error.message}));});
  await until(async()=>{try{return(await readFile(path.join(run,'resources.ndjson'),'utf8')).trim().split('\n').filter(Boolean).length;}catch{return 0;}},count=>count>=2,'two pre-Download resource baseline samples');
  networkStarted = true; report.actionAt = new Date().toISOString();
  report.action = await popup.evaluate(({quality,filename}) => {
    const article = [...document.querySelectorAll('.primary-media article')].find(a => [...a.querySelectorAll('select option')].some(o => o.textContent === quality));
    const select = article.querySelector('select'); select.value = [...select.options].find(o => o.textContent === quality).value; select.dispatchEvent(new Event('change', { bubbles: true }));
    const input = article.querySelector('input'); input.value = filename; input.dispatchEvent(new Event('input', { bubbles: true }));
    const button = article.querySelector('.download-start'); if (button.disabled) throw Error('disabled Download'); button.click();
    return { variantId: select.value, filename: input.value, via: 'actual action popup DOM Download click' };
  },{quality,filename});
  await save(); console.log(JSON.stringify({ started: true, run, profile: report.profile, port: report.port, pid: process.pid }));
  let lastLog = 0;
  for (;;) {
    let state,pageHeap;
    try { state = await popup.evaluate(async () => {
      const jobs = (await chrome.storage.local.get('downloadState')).downloadState?.jobs ?? [];
      return { jobs, ui: document.querySelector('.download-jobs')?.textContent };
    }); pageHeap=await cdp.send('Runtime.getHeapUsage'); }
    catch(error) {
      if(!String(error.message).startsWith('CDP timeout'))throw error;
      (report.observationTimeouts??=[]).push({at:new Date().toISOString(),message:error.message});
      await save();await delay(3000);continue; // An observer deadline is not a transfer failure.
    }
    const job = state.jobs[0];
    const sample = { at: new Date().toISOString(), job, ui: state.ui, requests: network.size, active, maximumActive, pageHeap };
    report.samples.push(sample); report.latest = sample;
    await appendFile(path.join(run, 'samples.ndjson'), JSON.stringify(sample) + '\n');
    if(job?.progress.inputBytes>0&&!report.firstInputProgress){report.firstInputProgress={at:sample.at,inputBytes:job.progress.inputBytes,outputBytes:job.progress.outputBytes};await popup.evaluate(id=>document.querySelector(`[data-job-id="${id}"]`)?.scrollIntoView(),job.id);const shot=await popup.send('Page.captureScreenshot',{format:'png'});await writeFile(path.join(run,'first-input-progress.png'),Buffer.from(shot.data,'base64'));}
    if(selection720&&job?.progress.inputBytes>=1048576&&!report.selectionControl){
      assert.equal(job.selection.height,720);const wrong=[...network.values()].filter(r=>r.url.includes('/1080p/'));assert.deepEqual(wrong,[],'720p action must not request 1080p resources');
      report.selectionControl={at:sample.at,scope:'Actual 720p selection and range IO, then deliberate popup Cancel; not a full720p saved-file run',selectedRequests:[...network.values()].filter(r=>r.url.includes('/720p/')).length,unsolicited1080Requests:wrong.length};
      await popup.evaluate(id=>document.querySelector(`[data-job-id="${id}"] .download-cancel`).click(),job.id);
    }
    if (Date.now() - lastLog > 30000) { console.log(JSON.stringify({ run, jobId: job?.id, phase: job?.phase, progress: job?.progress, requests: network.size, active })); lastLog = Date.now(); await save(); }
    if (job && ['complete', 'failed', 'canceled', 'interrupted'].includes(job.phase)) {
      report.finalJob = job;
      if (job.phase === 'complete') {
        report.browserDownload = await popup.evaluate(async id => (await chrome.downloads.search({ id }))[0], job.browserDownloadId);
        assert.equal(report.browserDownload.state, 'complete'); assert.equal(path.basename(report.browserDownload.filename), filename);
        report.chromeSaved = true;
      }
      await delay(2000);
      report.cleanup = await popup.evaluate(async () => {
        const root = await navigator.storage.getDirectory(), entries = [];
        for await (const [name, handle] of root.entries()) { if (handle.kind === 'directory') { const files = []; for await (const [file] of handle.entries()) files.push(file); entries.push({ name, files }); } else entries.push({ name }); }
        return { entries, jobs: (await chrome.storage.local.get('downloadState')).downloadState.jobs,downloads:await chrome.downloads.search({}) };
      });
      report.processingWorkersAfterCleanup=(await host.send('Target.getTargets')).targetInfos.filter(t=>t.type==='worker'&&t.url.includes(report.extensionId));
      assert.deepEqual(report.processingWorkersAfterCleanup,[]);
      await popup.evaluate(id=>document.querySelector(`[data-job-id="${id}"]`)?.scrollIntoView(),job.id);
      const shot = await popup.send('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(run, 'terminal-popup.png'), Buffer.from(shot.data, 'base64'));
      assert.equal(job.phase,selection720?'canceled':'complete',JSON.stringify(job.failure));
      assert.ok(report.cleanup.jobs.every(j=>!j.attachment&&!j.tempFile));assert.ok(report.cleanup.entries.every(e=>!e.files||e.files.length===0));
      if(selection720)assert.deepEqual(report.cleanup.downloads,[]);
      break;
    }
    await delay(3000);
  }
} catch (error) {
  report.errors.push(error.stack ?? String(error)); process.exitCode = 1;
  await page?.screenshot({ path: path.join(run, 'failure-page.png') }).catch(() => {});
} finally {
  report.network = [...network.values()]; report.maximumActive = maximumActive;
  await journal;
  report.artifactAfter = await hashes(path.resolve('dist'));
  report.artifactUnchanged = JSON.stringify(report.artifactBefore) === JSON.stringify(report.artifactAfter);
  if(!report.artifactUnchanged){report.errors.push('Production artifact changed during live run');process.exitCode=1;}
  for (const socket of sockets) socket.close();
  await context?.close(); report.ownedBrowserClosed = true;
  if(observerExit)report.observerExit=await observerExit;
  report.ended = new Date().toISOString(); await save(); console.log(JSON.stringify({ run, chromeSaved: report.chromeSaved, errors: report.errors, artifactUnchanged: report.artifactUnchanged }));
}
