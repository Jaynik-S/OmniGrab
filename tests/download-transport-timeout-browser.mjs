// Owned timeout-policy regression fixture; separate from Task6's acceptance/browser files.
// Actual MV3 offscreen/content ports, localhost CORS and independent HTTP/socket receipts.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const output = path.resolve('.cache/download-transport-timeout', `native-${Date.now()}-${process.pid}`);
const quick = process.argv.includes('--quick');
const arrayBufferConsumer = process.argv.includes('--array-buffer');
const extension = path.join(output, 'extension'); await mkdir(extension, { recursive: true });
const body = Buffer.from(Uint8Array.from({ length: 900001 }, (_, i) => i % 251));
const range = `bytes=0-${body.length - 1}`, contentRange = `bytes 0-${body.length - 1}/${body.length}`;
const expectedDigest = createHash('sha256').update(body).digest('hex');
const report = { startedAt: new Date().toISOString(), fixture: 'Original deterministic900001-byte multichunk pattern; no media/save or live Cinejoy claim.', quick, arrayBufferConsumer, requests: [], cases: [], errors: [], networkFailures: [], expectedDigest };
const sockets = new Set(); let active = 0, maximumActive = 0, pageOrigin, mediaOrigin, context;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pages = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><meta name="referrer" content="origin"><title>Owned idle-timeout transport regression</title>'); });
const media = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://fixture.invalid').pathname;
  const page = request.headers.referer?.startsWith(pageOrigin) === true;
  const entry = { pathname, page, origin: request.headers.origin ?? null, referer: request.headers.referer ?? null, range: request.headers.range ?? null, startedAt: Date.now(), bytes: 0 };
  report.requests.push(entry); active++; maximumActive = Math.max(maximumActive, active);
  response.once('close', () => { active--; entry.closedAt = Date.now(); entry.incomplete = !response.writableFinished; });
  request.socket.once('close', () => { entry.socketClosedAt = Date.now(); });
  const ordinal = report.requests.filter(r => r.pathname === pathname && r.page === page).length;
  const headers = { 'cache-control': 'no-store', 'content-type': 'image/jpeg', 'access-control-allow-origin': pageOrigin, 'access-control-expose-headers': 'Content-Range, Content-Length' };
  const send = (status, bytes, extra = {}) => { entry.status = status; entry.headersAt = Date.now(); response.writeHead(status, { ...headers, 'content-length': bytes.length, ...extra }); entry.bytes = bytes.length; response.end(bytes); };
  if (pathname === '/fallback.jpg' && !page || pathname === '/primary-retry.jpg' && ordinal === 1 || pathname === '/exhaust.jpg') return; // Withhold every header and body byte.
  if (pathname === '/page-retry.jpg' && !page) { send(404, Buffer.from('page required')); return; }
  if (pathname === '/page-retry.jpg' && page && ordinal === 1) return;
  if (pathname === '/body-stall.jpg') {
    entry.status = 200; entry.headersAt = Date.now(); response.writeHead(200, { ...headers, 'content-length': body.length }); response.flushHeaders();
    response.write(body.subarray(0, 32768)); entry.bytes = 32768; return;
  }
  assert.equal(request.headers.range, range);
  send(206, body, { 'content-range': contentRange });
});
for (const server of [media, pages]) server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await listen(pages); pageOrigin = `http://127.0.0.1:${pages.address().port}`; await listen(media); mediaOrigin = `http://127.0.0.1:${media.address().port}`;
const bundle = (name, contents) => build({ stdin: { contents, resolveDir: path.resolve('.'), loader: 'ts' }, outfile: path.join(extension, name), bundle: true, platform: 'browser', format: name === 'content.js' ? 'iife' : 'esm', target: 'chrome120', plugins: quick ? [{name:'ignored-native-diagnostic-trace',setup(b){b.onLoad({filter:/downloads[\\/]transport\.ts$/},async args=>({loader:'ts',contents:(await readFile(args.path,'utf8')).replace('catch (error) { errorBody(error); discard(); send(', 'catch (error) { ((globalThis as any).__nativeProtocolErrors ??= []).push(String((error as Error).stack ?? error)); errorBody(error); discard(); send(')}));}}] : [] });
await writeFile(path.join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Owned pre-header idle regression', version: '1.0', minimum_chrome_version: '120', permissions: ['offscreen', 'tabs', 'webNavigation'], host_permissions: ['http://127.0.0.1/*'], background: { service_worker: 'coordinator.js', type: 'module' }, content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['content.js'], run_at: 'document_start' }] }));
await writeFile(path.join(extension, 'host.html'), '<!doctype html><script type="module" src="host.js"></script>');
await writeFile(path.join(extension, 'controller.html'), '<!doctype html><title>Owned timeout controls</title>');
await bundle('content.js', `import {createDownloadAttachmentHandler} from './src/content/download-fetch.ts';chrome.runtime.onMessage.addListener(createDownloadAttachmentHandler(chrome.runtime.id));`);
await bundle('coordinator.js', `
chrome.runtime.onMessage.addListener((m,s,reply)=>{if(m.target!=='coordinator')return;(async()=>{
 if(m.action==='validate'){const frame=await chrome.webNavigation.getFrame({tabId:m.selection.tabId,frameId:m.selection.frameId});return !!frame&&frame.documentId===m.selection.documentId;}
 if(m.action==='init'){
  if(!await chrome.offscreen.hasDocument())await chrome.offscreen.createDocument({url:'host.html',reasons:['BLOBS'],justification:'Owned native timeout-policy regression'});
  const tab=(await chrome.tabs.query({})).find(t=>t.url===m.pageUrl),frame=await chrome.webNavigation.getFrame({tabId:tab.id,frameId:0});
  const selection={tabId:tab.id,frameId:0,documentId:frame.documentId,epoch:1,mediaId:'timeout-fixture',instance:1,pageUrl:m.pageUrl,sourceUrl:m.sourceUrl,videoUrl:m.sourceUrl,filename:'fixture.mp4',output:'mp4'};
  const result=await chrome.runtime.sendMessage({target:'host',action:'init',selection,jobId:m.jobId,idleMs:m.idleMs,url:m.url});if(!result.ok)throw Error(result.error);
  if(m.page){const attached=await chrome.tabs.sendMessage(tab.id,result.value,{frameId:0,documentId:frame.documentId});if(!attached?.ok)throw Error('content attachment failed');}
  return selection;
 }
 if(m.action==='close'){await chrome.offscreen.closeDocument();return {offscreenRemaining:(await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})).length};}
})().then(value=>reply({ok:true,value}),e=>reply({ok:false,error:String(e.stack||e)}));return true;});`);
await bundle('host.js', `
import {createDownloadTransport} from './src/downloads/transport.ts';let transport,state,attached=false,events=[],primaryAborts=[];
chrome.runtime.onConnect.addListener(port=>{const post=port.postMessage.bind(port);port.postMessage=m=>{if(m.type==='ack')events.push({at:Date.now(),direction:'host-to-page',type:m.type,requestId:m.requestId,sequence:m.sequence,offset:m.offset});post(m);};port.onMessage.addListener(m=>events.push({at:Date.now(),direction:'page-to-host',type:m.type,requestId:m.requestId,error:m.error,sequence:m.sequence,offset:m.offset,bytes:m.bytes}));transport.acceptPort(port).then(value=>{attached=value;}).catch(e=>{state={done:true,error:String(e)};});});
chrome.runtime.onMessage.addListener((m,s,reply)=>{if(m.target!=='host')return;(async()=>{
 if(m.action==='init'){if(transport)await transport.dispose();state={done:false};attached=false;events=[];primaryAborts=[];
  transport=createDownloadTransport({jobId:m.jobId,selection:m.selection,...(m.idleMs?{idleMs:m.idleMs}:{}),fetcher:(input,init)=>{init.signal.addEventListener('abort',()=>primaryAborts.push({at:Date.now(),reason:String(init.signal.reason?.message||init.signal.reason)}),{once:true});return globalThis.fetch(input,init);},validateDocument:async()=>{const r=await chrome.runtime.sendMessage({target:'coordinator',action:'validate',selection:m.selection});return r?.ok&&r.value;}});
  transport.grantResources([{url:m.url}]);return transport.expectAttachment(crypto.randomUUID()+crypto.randomUUID());
 }
 if(m.action==='start'){(async()=>{try{const r=await transport.fetch(m.url,m.body?undefined:{headers:{Range:${JSON.stringify(range)}}});state.headers={status:r.status,url:r.url,range:r.headers.get('content-range'),mime:r.headers.get('content-type')};let bytes;
  if(m.arrayBufferConsumer)bytes=await r.arrayBuffer();else{const reader=r.body.getReader(),chunks=[];let length=0;while(true){const part=await reader.read();if(part.done)break;chunks.push(part.value);length+=part.value.length;}const joined=new Uint8Array(length);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.length;}bytes=joined.buffer;}
  state.bytes=bytes.byteLength;state.digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');}catch(e){state.error=String(e.message||e);state.stack=String(e.stack);}finally{state.done=true;}})();return true;}
 if(m.action==='status')return {attached,state,metrics:transport.metrics,events,primaryAborts,protocolErrors:globalThis.__nativeProtocolErrors};
 if(m.action==='dispose'){await transport.dispose();return transport.metrics;}
})().then(value=>reply({ok:true,value}),e=>reply({ok:false,error:String(e.stack||e)}));return true;});`);

async function until(read, accept, label, timeout = 25000) { const end = Date.now() + timeout; let last; while (Date.now() < end) { last = await read(); if (accept(last)) return last; await sleep(25); } throw Error(`${label}: ${JSON.stringify(last)}`); }
try {
  const profile = await mkdtemp(path.join(tmpdir(), 'owned-transport-timeout-')); report.profile = profile;
  context = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROMIUM_PATH ?? 'C:/Users/jay03/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--remote-debugging-port=0'] });
  context.on('requestfailed', request => { if(request.url().startsWith(mediaOrigin))report.networkFailures.push({url:request.url(),at:Date.now(),failure:request.failure()}); });
  report.browser = context.browser()?.version(); report.debuggingPort = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); assert.ok(report.debuggingPort > 0 && report.debuggingPort !== 9222);
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker'); const extensionId = new URL(worker.url()).hostname;
  const control = await context.newPage(); await control.goto(`chrome-extension://${extensionId}/controller.html`); const page = await context.newPage(); await page.goto(pageOrigin + '/watch');
  const call = async (target, action, args = {}) => { const result = await control.evaluate(m => chrome.runtime.sendMessage(m), { target, action, ...args }); assert.ok(result?.ok, result?.error ?? 'missing fixture reply'); return result.value; };
  report.directPageProbe=await page.evaluate(async ({url,range})=>{try{const r=await fetch(url,{headers:{Range:range}});return {status:r.status,headers:[...r.headers],bytes:(await r.arrayBuffer()).byteLength};}catch(e){return {error:String(e)};}},{url:mediaOrigin+'/direct-probe.jpg',range});assert.equal(report.directPageProbe.bytes,body.length);
  for (const fixture of [
    { id: 'fallback', page: true, attempts: 2, ...(quick?{idleMs:200}:{}) }, // Default run uses the production15s idle /120s shared deadline.
    { id: 'primary-retry', page: false, idleMs: 200, attempts: 2 },
    { id: 'page-retry', page: true, idleMs: 200, attempts: 3 },
    { id: 'exhaust', page: true, idleMs: 200, attempts: 3, error: true },
    { id: 'body-stall', page: true, idleMs: 200, attempts: 1, error: true, body: true },
  ]) {
    const url = `${mediaOrigin}/${fixture.id}.jpg`; const selected = await call('coordinator', 'init', { ...fixture, jobId: fixture.id, pageUrl: page.url(), sourceUrl: mediaOrigin + '/manifest.m3u8', url });
    if (fixture.page) await until(() => call('host', 'status'), r => r.attached, 'direct current-document port');
    const startedAt = Date.now(); await call('host', 'start', { url, body: fixture.body, arrayBufferConsumer });
    const result = await until(() => call('host', 'status').then(r=>{report.lastStatus=r;return r;}), r => r.state.done && r.metrics.active === 0, fixture.id,quick?3000:25000);
    const requests = report.requests.filter(r => r.pathname === `/${fixture.id}.jpg`);
    await until(async () => requests, entries => entries.every(r => r.closedAt), 'all physical responses settled');
    assert.equal(result.metrics.attempts, fixture.attempts); assert.equal(requests.length, fixture.attempts); assert.equal(result.metrics.active, 0); assert.equal(result.metrics.queuedBytes, 0); assert.ok(result.metrics.maximumActive <= 4); assert.ok(result.metrics.maximumQueuedBytes <= 8 * 1024 * 1024);
    if (fixture.error) {
      // Chromium's native arrayBuffer wraps a body-stream error; pre-header errors stay exact.
      assert.equal(result.state.error, fixture.body && arrayBufferConsumer ? 'Failed to fetch' : 'download-timeout'); assert.equal(result.state.bytes, undefined);
      if(fixture.body)assert.equal(result.primaryAborts[0]?.reason,'download-timeout');
    }
    else {
      assert.equal(result.state.bytes, body.length); assert.equal(result.state.digest, expectedDigest); assert.equal(result.state.headers.status, 206); assert.equal(result.state.headers.range, contentRange);
      const chunks=result.events.filter(e=>e.type==='chunk'),acks=result.events.filter(e=>e.type==='ack');assert.equal(acks.length,chunks.length,'one ACK per accepted chunk');
      let offset=0;for(let i=0;i<chunks.length;i++){assert.equal(chunks[i].sequence,i);assert.equal(chunks[i].offset,offset);assert.ok(chunks[i].bytes>0&&chunks[i].bytes<=262144);offset+=chunks[i].bytes;assert.equal(acks[i].requestId,chunks[i].requestId);assert.equal(acks[i].sequence,i);assert.equal(acks[i].offset,offset);}
      if(fixture.page){assert.ok(chunks.length>1,'native fast drain must span multiple actual chunks');assert.equal(offset,body.length);const ends=result.events.filter(e=>e.type==='end');assert.equal(ends.length,1);assert.equal(ends[0].sequence,chunks.length);assert.equal(ends[0].offset,body.length);assert.equal(result.metrics.maximumUnacknowledgedPerRequest,1);}
    }
    if (fixture.id === 'fallback') {
      assert.equal(requests[0].page, false); assert.equal(requests[0].status, undefined); assert.equal(requests[0].bytes, 0); assert.equal(requests[0].incomplete, true);
      assert.ok(requests[0].closedAt - requests[0].startedAt >= (quick?150:14500)); assert.ok(requests[0].closedAt - requests[0].startedAt < (quick?2000:17000));
      await until(async () => requests[0], r => !!r.socketClosedAt, 'native primary socket close'); assert.ok(requests[0].socketClosedAt <= requests[1].startedAt, 'no replacement request before physical primary socket close');
      assert.equal(requests[1].page, true); assert.equal(requests[1].origin, pageOrigin);
    }
    if (fixture.id === 'page-retry') { assert.deepEqual(requests.map(r => r.page), [false, true, true]); assert.equal(requests[1].status, undefined); assert.ok(requests[1].closedAt <= requests[2].startedAt); }
    if (fixture.body) { assert.equal(requests.length, 1); assert.equal(requests[0].page, false); assert.equal(result.metrics.receivedBytes, 32768); assert.equal(requests[0].incomplete, true); }
    report.cases.push({ ...fixture, selected, startedAt, completedAt: Date.now(), result }); await call('host', 'dispose');
  }
  report.cleanup = { ...(await call('coordinator', 'close')), activeResponses: active, maximumActiveResponses: maximumActive };
  assert.equal(report.cleanup.offscreenRemaining, 0); assert.equal(active, 0); assert.equal(maximumActive, 1); report.ok = true;
} catch (error) { report.ok = false; report.errors.push(String(error.stack || error)); process.exitCode = 1; }
finally {
  if (context) { await context.close(); report.browserClosed = true; }
  for (const socket of sockets) socket.destroy(); await Promise.all([media, pages].map(server => new Promise(resolve => server.close(resolve))));
  report.finishedAt = new Date().toISOString(); await writeFile(path.join(output, 'evidence.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, output, cases: report.cases.map(c => c.id), cleanup: report.cleanup, browserClosed: report.browserClosed, errors: report.errors }));
}
