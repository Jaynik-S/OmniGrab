// Owned native MV3/offscreen fixture. No user's profile, remote executable code, or port9222.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { windowFixture } from './download-speed-fixture.ts';

const output = path.resolve('.cache/download-transport', `native-${Date.now()}-${process.pid}`);
const fixRound1 = process.argv.includes('--fix-round1');
const largeIO = process.argv.includes('--large-io');
const windowArgument = process.argv.find(arg => arg.startsWith('--read-window-mib='));
const windowMiB = windowArgument ? Number(windowArgument.split('=')[1]) : undefined;
const delayArgument=process.argv.find(arg=>arg.startsWith('--network-delay-ms='));
const networkDelayMs=delayArgument?Number(delayArgument.split('=')[1]):25;
assert.ok(Number.isSafeInteger(networkDelayMs)&&networkDelayMs>=0&&networkDelayMs<=1000,'bounded fixture delay');
assert.ok(windowMiB === undefined || [1, 4, 8].includes(windowMiB), 'read window must be 1, 4 or 8 MiB');
assert.ok(!windowMiB || !largeIO, 'window control and >2GiB control run separately');
const extension = path.join(output, 'extension'); await mkdir(extension, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { started: new Date().toISOString(), requests: [], cases: [], errors: [] };
if(largeIO||windowMiB)report.sourceHashes=Object.fromEntries(await Promise.all(['src/downloads/transport.ts','src/downloads/base64.ts','src/downloads/binary-protocol.ts','src/content/download-fetch.ts','src/downloads/opfs.ts','src/downloads/remux-source.ts','src/downloads/remux-read-cache.ts'].map(async file=>[file,createHash('sha256').update(await readFile(file)).digest('hex')])));
const sockets = new Set(), timers = new Set();
let pageOrigin, mediaOrigin, embedOrigin, context, observer, observerExit;
const media = createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture.invalid'); const page = [pageOrigin, embedOrigin].some(origin => req.headers.referer?.startsWith(origin));
  const entry = { url: url.pathname, page, range: req.headers.range, origin: req.headers.origin, referer: req.headers.referer, start: Date.now(), bytes: 0 };
  report.requests.push(entry); res.on('close', () => { entry.closed = Date.now(); entry.incomplete = !res.writableFinished; });
  const cors = url.pathname.includes('cors-deny') ? {} : { 'access-control-allow-origin': req.headers.origin === embedOrigin ? embedOrigin : pageOrigin, 'access-control-expose-headers': 'Content-Range, Content-Length, Accept-Ranges' };
  const send = (status, bytes, extra = {}) => { entry.status = status; res.writeHead(status, { ...cors, 'cache-control': 'no-store', 'content-type': 'image/jpeg', 'content-length': String(bytes.length), ...extra }); entry.bytes += bytes.length; res.end(bytes); };
  if (!page && !url.pathname.includes('retry')) { send(404, Buffer.from('context unavailable')); return; }
  if (url.pathname.startsWith('/window-')) {
    const size = Number(url.searchParams.get('size')), match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    assert.ok(size >= 1 && size <= 8 * 1024 * 1024 && match);
    const start = Number(match[1]), end = Math.min(Number(match[2]), size - 1);
    entry.status = 206;
    const timer = setTimeout(() => {
      timers.delete(timer); if(res.destroyed)return;
      res.writeHead(206, { ...cors, 'content-type':'application/octet-stream', 'content-length':end-start+1,'content-range':`bytes ${start}-${end}/${size}` });
      const chunk=Buffer.alloc(65536,90); let remaining=end-start+1;
      const pump=()=>{while(remaining&&!res.destroyed){const n=Math.min(remaining,chunk.length);remaining-=n;entry.bytes+=n;if(!res.write(chunk.subarray(0,n))){res.once('drain',pump);return;}}if(!remaining)res.end();};pump();
    }, networkDelayMs);timers.add(timer);res.once('close',()=>{clearTimeout(timer);timers.delete(timer);});return;
  }
  if (url.pathname === '/large-io.bin') {
    const size = 2 ** 31 + 65537, match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (!match) { send(416, Buffer.alloc(0)); return; }
    const start = Number(match[1]), end = Math.min(Number(match[2]), size - 1);
    if (start > end || end - start + 1 > 32 * 1024 * 1024) { send(416, Buffer.alloc(0)); return; }
    entry.status = 206; res.writeHead(206, { ...cors, 'content-type': 'application/octet-stream', 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}` });
    const chunk = Buffer.alloc(65536, 90); let remaining = end - start + 1;
    const pump = () => { while (remaining && !res.destroyed) { const n = Math.min(remaining, chunk.length); remaining -= n; entry.bytes += n; if (!res.write(chunk.subarray(0, n))) { res.once('drain', pump); return; } } if (!remaining) res.end(); };
    pump(); return;
  }
  if (url.pathname.includes('retry')) { send(503, Buffer.from('retryable')); return; }
  if (url.pathname.includes('gzip.m3u8')) { send(200, gzipSync(url.pathname.includes('oversize-') ? Buffer.alloc(2097153,65) : Buffer.from('#EXTM3U\n#EXT-X-ENDLIST')), { 'content-encoding': 'gzip' }); return; }
  if (url.pathname.includes('headers-stall')) return;
  if (url.pathname.includes('redirect')) { entry.status = 302; res.writeHead(302, { ...cors, location: '/binary-final.jpg?signature=exact%2Fquery' }); res.end(); return; }
  const bytes = Buffer.alloc(900001); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  if (url.pathname.includes('range-bad')) { send(206, bytes.subarray(0, 10), { 'content-range': 'bytes 9-18/900001' }); return; }
  if (req.headers.range) { const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range); const start = Number(match[1]), end = Math.min(Number(match[2]), bytes.length - 1); send(206, bytes.subarray(start, end + 1), { 'content-range': `bytes ${start}-${end}/${bytes.length}` }); return; }
  if (url.pathname.includes('body-stall') || url.pathname.includes('slow')) {
    entry.status = 200; res.writeHead(200, { ...cors, 'cache-control': 'no-store', 'content-type': 'image/jpeg', 'content-length': bytes.length }); res.flushHeaders();
    let offset = 0;
    const timer = setInterval(() => {
      if (res.destroyed) return;
      if (url.pathname.includes('body-stall') && offset > 0) return;
      const end = Math.min(offset + 32768, bytes.length); res.write(bytes.subarray(offset, end)); entry.bytes += end - offset; offset = end;
      if (offset === bytes.length) { clearInterval(timer); timers.delete(timer); res.end(); }
    }, 35); timers.add(timer); res.once('close', () => { clearInterval(timer); timers.delete(timer); }); return;
  }
  send(200, bytes);
});
const pages = createServer((q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><meta name="referrer" content="origin"><title>Owned transport fixture</title>' + (q.url === '/iframe-watch' ? `<iframe src="${embedOrigin}/embed-player"></iframe>` : '')); });
for (const server of [pages, media]) server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await listen(pages); pageOrigin = `http://127.0.0.1:${pages.address().port}`; embedOrigin = `http://localhost:${pages.address().port}`; await listen(media); mediaOrigin = `http://127.0.0.1:${media.address().port}`;
const bundle = async (name, contents) => build({ stdin: { contents, resolveDir: path.resolve('.'), loader: 'ts' }, outfile: path.join(extension, name), bundle: true, format: name === 'content.js' ? 'iife' : 'esm', platform: 'browser', target: 'chrome120' });
await writeFile(path.join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Owned bounded transport fixture', version: '1.0', minimum_chrome_version: '120', permissions: ['offscreen', 'tabs', 'webNavigation', 'storage'], host_permissions: ['http://127.0.0.1/*', 'http://localhost/*'], background: { service_worker: 'worker.js', type: 'module' }, content_scripts: [{ matches: ['http://127.0.0.1/*', 'http://localhost/*'], js: ['content.js'], run_at: 'document_start', all_frames: true }] }));
await writeFile(path.join(extension, 'host.html'), '<!doctype html><script type="module" src="host.js"></script>');
await writeFile(path.join(extension, 'controller.html'), '<!doctype html><title>Native transport controls</title>');
if (largeIO || windowMiB) await bundle('io-worker.js', `
import {createOpfsOutput} from './src/downloads/opfs.ts';
import {RemuxSourceAdapter} from './src/downloads/remux-source.ts';
let response,requestId=0;const pending=new Map();
self.onmessage=async({data:m})=>{
 if(m.type==='response'){if(m.id){const resolve=pending.get(m.id);pending.delete(m.id);resolve(m.body);}else response(m.body);return;}
 if(m.type!=='run')return;
 let output,source;const started=performance.now();
 try {
  const directory=await navigator.storage.getDirectory();output=await createOpfsOutput(directory,'large-io.bin');
  if(m.plan){
   const fetcher=async(url,init)=>{const range=/bytes=(\\d+)-(\\d+)/.exec(new Headers(init.headers).get('Range'));const id=++requestId;const value=await new Promise(resolve=>{pending.set(id,resolve);self.postMessage({type:'fetch',id,url,start:Number(range[1]),end:Number(range[2])});});const result=new Response(value.body,{status:value.status,headers:value.headers});Object.defineProperty(result,'url',{value:url});return result;};
   source=new RemuxSourceAdapter(m.plan,fetcher,new AbortController().signal,()=>{}, {readWindowBytes:m.windowMiB*1024*1024});
   let bytes=0,checked=0;
   for(const grant of m.plan.resources){let offset=0;const size=Number(new URL(grant.url).searchParams.get('size'));while(offset<size){const result=await source.fetch(grant.url,{headers:{Range:'bytes='+offset+'-'+Math.min(offset+262143,size-1)}});const part=new Uint8Array(await result.arrayBuffer());if(!part.length)throw Error('empty window');for(const byte of part){if(byte!==90)throw Error('window content mismatch');checked++;}await output.write(part,bytes);bytes+=part.length;offset+=part.length;}}
   await source.settled();const metrics={...source.metrics};source.dispose();await output.flush();await output.close();const file=await(await directory.getFileHandle('large-io.bin')).getFile();await directory.removeEntry('large-io.bin');self.postMessage({type:'complete',bytes,checked,fileSize:file.size,removed:true,metrics,elapsedMs:performance.now()-started});return;
  }
  let bytes=0,checked=0,chunks=0;const size=2**31+65537;
  while(bytes<size){const end=Math.min(bytes+32*1024*1024-1,size-1);const body=await new Promise(resolve=>{response=resolve;self.postMessage({type:'fetch',url:m.url,start:bytes,end});});const reader=body.getReader();
   for(;;){const p=await reader.read();if(p.done)break;for(const value of p.value){if(value!==90)throw Error('binary content mismatch');checked++;}await output.write(p.value,bytes);bytes+=p.value.length;chunks++;}
   self.postMessage({type:'progress',bytes,checked,chunks});
  }
  if(bytes!==size)throw Error('large length mismatch');
  await output.write(Uint8Array.of(1,2,3,4),2**31-1);await output.flush();await output.close();
  const file=await(await directory.getFileHandle('large-io.bin')).getFile();const slices=[];
  for(const [start,length]of [[0,4],[2**31-2,6],[size-4,4]])slices.push({start,bytes:[...new Uint8Array(await file.slice(start,start+length).arrayBuffer())]});
  const handle=await(await directory.getFileHandle('large-io.bin')).createSyncAccessHandle();handle.close();
  await directory.removeEntry('large-io.bin');
  self.postMessage({type:'complete',bytes,checked,chunks,fileSize:file.size,slices,removed:true,elapsedMs:performance.now()-started});
 }catch(e){source?.dispose();await output?.close();self.postMessage({type:'failed',error:String(e.stack||e)});}
};`);
await bundle('content.js', `import {createDownloadAttachmentHandler} from './src/content/download-fetch.ts'; let ownedPort;const handler=createDownloadAttachmentHandler(chrome.runtime.id,{connect:name=>{ownedPort=chrome.runtime.connect({name});return ownedPort;}}); chrome.runtime.onMessage.addListener(handler);chrome.runtime.onMessage.addListener((m,s,reply)=>{if(m.type==='fixture-drop'&&s.id===chrome.runtime.id&&!s.tab){ownedPort.disconnect();reply({ok:true});}});`);
await bundle('worker.js', `
chrome.runtime.onMessage.addListener((m,s,reply)=>{
 if(m.target!=='coordinator') return;
 (async()=>{
  if(m.action==='validate'){ const f=await chrome.webNavigation.getFrame({tabId:m.selection.tabId,frameId:m.selection.frameId}); const tab=await chrome.tabs.get(m.selection.tabId);return !!f&&f.documentId===m.selection.documentId&&tab.url===m.selection.pageUrl; }
  if(m.action==='init'){
   if(!await chrome.offscreen.hasDocument()) await chrome.offscreen.createDocument({url:'host.html',reasons:['BLOBS'],justification:'Native local bounded binary transport verification'});
   const tab=(await chrome.tabs.query({})).find(t=>t.url===m.pageUrl);const frameId=m.frameUrl?(await chrome.webNavigation.getAllFrames({tabId:tab.id})).find(f=>f.url===m.frameUrl).frameId:0; const f=await chrome.webNavigation.getFrame({tabId:tab.id,frameId});
   const selection={tabId:tab.id,frameId,documentId:f.documentId,epoch:1,mediaId:'native',instance:1,pageUrl:m.pageUrl,sourceUrl:m.sourceUrl,videoUrl:m.sourceUrl,filename:'native.mp4',output:'mp4'};
   const hostReply=await chrome.runtime.sendMessage({target:'host',action:'init',selection,id:m.id,idleMs:m.idleMs,requestMs:m.requestMs});if(!hostReply.ok)throw new Error(hostReply.error);const payload=hostReply.value;
   await chrome.storage.session.set({attachment:payload});
   const receipt=await chrome.tabs.sendMessage(tab.id,payload,{frameId,documentId:f.documentId}); if(!receipt.ok)throw new Error(JSON.stringify(receipt)); return selection;
  }
  if(m.action==='detach'){
   const {attachment:a}=await chrome.storage.session.get('attachment');const receipt=await chrome.tabs.sendMessage(a.selection.tabId,{type:'download-detach',jobId:a.jobId,capability:a.capability},{frameId:a.selection.frameId,documentId:a.selection.documentId});
   if(!receipt.ok||!receipt.settled||receipt.jobId!==a.jobId||receipt.capability!==a.capability)throw new Error('detach receipt invalid');
   await chrome.runtime.sendMessage({target:'host',action:'confirm',capability:a.capability}); return receipt;
  }
  if(m.action==='drop'){const {attachment:a}=await chrome.storage.session.get('attachment');return chrome.tabs.sendMessage(a.selection.tabId,{type:'fixture-drop'},{frameId:a.selection.frameId,documentId:a.selection.documentId});}
  if(m.action==='churn128'){
   const {attachment:a}=await chrome.storage.session.get('attachment');const target={frameId:a.selection.frameId,documentId:a.selection.documentId};let completed=0;
   for(let i=0;i<128;i++){const capability=crypto.randomUUID()+crypto.randomUUID(),jobId='churn'+i;const attach=await chrome.tabs.sendMessage(a.selection.tabId,{...a,jobId,capability,expiresAt:Date.now()+10000},target);if(!attach.ok)throw new Error('churn attach '+i+JSON.stringify(attach));const detach=await chrome.tabs.sendMessage(a.selection.tabId,{type:'download-detach',jobId,capability},target);if(!detach.ok||!detach.settled||detach.capability!==capability)throw new Error('churn detach '+i);completed++;}
   const replay=await chrome.tabs.sendMessage(a.selection.tabId,{...a,expiresAt:Date.now()+10000},target);return {completed,replay};
  }
  return 'wake';
 })().then(v=>reply({ok:true,value:v}),e=>reply({ok:false,error:String(e.stack||e)})); return true;
});`);
await bundle('host.js', `
import {createDownloadTransport} from './src/downloads/transport.ts';
let transport,capability,attachment,connectedPort,acceptedSender;const work=new Map();
globalThis.__nativeStatus=()=>({metrics:transport.metrics,acceptedSender,work:Object.fromEntries([...work].map(([k,v])=>[k,{done:v.done,error:v.error,headers:v.headers,bytes:v.bytes,sum:v.sum}]))});
chrome.runtime.onConnect.addListener(port=>{connectedPort=port;transport?.acceptPort(port).then(accepted=>{if(accepted)acceptedSender={tabId:port.sender.tab.id,frameId:port.sender.frameId,documentId:port.sender.documentId,url:port.sender.url};}).catch(e=>console.error(e));});
chrome.runtime.onMessage.addListener((m,s,reply)=>{
 if(m.target!=='host')return;
 (async()=>{
  if(m.action==='init'){
   if(transport)await transport.dispose(); work.clear();acceptedSender=undefined;
   transport=createDownloadTransport({jobId:m.id,selection:m.selection,idleMs:m.idleMs,requestMs:m.requestMs,validateDocument:async()=>{const r=await chrome.runtime.sendMessage({target:'coordinator',action:'validate',selection:m.selection});return r.ok&&r.value;}});
   capability=crypto.randomUUID()+crypto.randomUUID();attachment=transport.expectAttachment(capability);return attachment;
  }
  if(m.action==='grant'){transport.grantResources(m.grants);return true;}
  if(m.action==='manifests'){transport.grantManifests(m.urls);return true;}
  if(m.action==='fetch'){
   const item={done:false}; work.set(m.id,item); let release; item.gate=new Promise(r=>release=r);item.release=release;
   item.promise=(async()=>{try{const response=await transport.fetch(m.url,{headers:m.range?{Range:m.range}:undefined});item.headers={status:response.status,url:response.url,mime:response.headers.get('content-type'),range:response.headers.get('content-range'),encoding:response.headers.get('content-encoding'),length:response.headers.get('content-length')};if(m.pause)await item.gate;
    const reader=response.body.getReader();let bytes=0,sum=0;while(true){const p=await reader.read();if(p.done)break;bytes+=p.value.length;for(const b of p.value)sum+=b;}item.bytes=bytes;item.sum=sum;
   }catch(e){item.error=String(e.message||e);}finally{item.done=true;}})(); return true;
  }
  if(m.action==='consume'){work.get(m.id).release();return true;}
  if(m.action==='abort'){for(const i of work.values())i.release();await transport.abort();return transport.metrics;}
  if(m.action==='disconnect'){for(const i of work.values())i.release();connectedPort.disconnect();return transport.metrics;}
  if(m.action==='confirm'){transport.confirmAttachmentStopped(m.capability);return transport.metrics;}
  if(m.action==='status')return globalThis.__nativeStatus();
  if(m.action==='large-proof')return work.get('large');
  if(m.action==='large-io'){
   const item={done:false,release:()=>{}};work.set('large',item);const io=new Worker('io-worker.js',{type:'module'});
   io.onmessage=({data})=>{if(data.type==='fetch'){void(async()=>{const r=await transport.fetch(data.url,{headers:{Range:'bytes='+data.start+'-'+data.end}});io.postMessage({type:'response',id:data.id,body:m.plan?{body:r.body,status:r.status,headers:[...r.headers]}:r.body},[r.body]);})().catch(e=>{item.error=String(e);item.done=true;io.terminate();});}
    else if(data.type==='progress')Object.assign(item,data);
    else {Object.assign(item,data,{done:true});io.terminate();}};
   io.onerror=e=>{item.error=e.message;item.done=true;io.terminate();};io.postMessage({type:'run',url:m.url,plan:m.plan,windowMiB:m.windowMiB});return true;
  }
  if(m.action==='dispose'){for(const i of work.values())i.release();await transport.dispose();return transport.metrics;}
 })().then(v=>reply({ok:true,value:v}),e=>reply({ok:false,error:String(e.stack||e)}));return true;
});`);

async function until(callback, predicate, label, timeout = 12000) { const deadline = Date.now() + timeout; let last; while (Date.now() < deadline) { last = await callback(); if (predicate(last)) return last; await sleep(40); } throw new Error(`Timeout ${label}: ${JSON.stringify(last)}`); }
try {
  const profile = await mkdtemp(path.join(tmpdir(), 'owned-download-transport-')); report.profile = profile;
  context = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROMIUM_PATH ?? 'C:/Users/jay03/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--remote-debugging-port=0'] });
  report.networkFailures=[];context.on('requestfailed',request=>report.networkFailures.push({url:request.url(),failure:request.failure(),at:Date.now()}));
  report.browser = context.browser()?.version(); const port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); assert.ok(port > 0 && port !== 9222); report.debuggingPort = port;
  report.pid=process.pid;await writeFile(path.join(output,'live.json'),JSON.stringify({pid:process.pid,profile,port,output}));console.log(JSON.stringify({started:true,pid:process.pid,profile,port,output}));
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker'); const extensionId = new URL(worker.url()).hostname;
  const control = await context.newPage(); await control.goto(`chrome-extension://${extensionId}/controller.html`);
  const page = await context.newPage(); await page.goto(pageOrigin + '/watch');
  if(largeIO){
    await writeFile(path.join(output,'receipt.json'),JSON.stringify({profile,port,pid:process.pid}));
    observer=spawn(process.execPath,['tests/download-acceptance-observe.mjs',output],{stdio:['ignore','ignore','inherit'],windowsHide:true});report.observerPid=observer.pid;
    observerExit=new Promise(resolve=>{observer.once('exit',(code,signal)=>resolve({code,signal}));observer.once('error',error=>resolve({error:error.message}));});
    await until(async()=>{try{return(await readFile(path.join(output,'resources.ndjson'),'utf8')).trim().split('\n').length;}catch{return 0;}},count=>count>=1,'pre-transfer read-only resource sample');
    console.log(JSON.stringify({observerPid:observer.pid,output,pid:process.pid}));
  }
  const call = async (target, action, args = {}) => { const r = await control.evaluate(m => chrome.runtime.sendMessage(m), { target, action, ...args }); assert.ok(r?.ok, r?.error || 'missing control reply'); return r.value; };
  const status = () => call('host', 'status');
  const init = async (id, idleMs = 2000) => { await call('coordinator', 'init', { id, pageUrl: page.url(), sourceUrl: mediaOrigin + '/manifest.m3u8', idleMs, requestMs: 8000 }); await sleep(50); };
  const fetchOne = async (id, suffix, args = {}) => { const url = mediaOrigin + suffix; await call('host', 'grant', { grants: [{ url, ...(args.grantRange ? { range: args.grantRange } : {}) }] }); await call('host', 'fetch', { id, url, ...args }); const result=await until(status, s => s.work[id]?.done, id);report.lastResult=result;return result; };
  if (windowMiB) {
    const fixture=windowFixture(mediaOrigin),selection=await call('coordinator','init',{id:'window-'+windowMiB,pageUrl:page.url(),sourceUrl:mediaOrigin+'/manifest.m3u8',idleMs:15000,requestMs:120000});
    await call('host','grant',{grants:fixture.resources});
    const plan={selection,manifests:[{url:selection.videoUrl,text:fixture.text}],resources:fixture.resources};
    await call('host','large-io',{plan,windowMiB});
    const final=await until(status,s=>s.work.large?.done,'window control',180000),proof=await call('host','large-proof');
    report.lastResult={final,proof};
    assert.equal(proof.error,undefined);assert.equal(proof.bytes,fixture.expectedBytes);assert.equal(proof.checked,fixture.expectedBytes);assert.equal(proof.fileSize,fixture.expectedBytes);assert.equal(proof.removed,true);
    assert.ok(proof.metrics.maximumActive<=4);assert.ok(proof.metrics.maximumSpeculative<=3);assert.ok(proof.metrics.maximumCachedBytes<=32*1024*1024);assert.ok(proof.metrics.maximumInFlightBytes<=32*1024*1024);
    assert.ok(final.metrics.maximumQueuedBytes<=8*1024*1024);assert.equal(final.metrics.maximumUnacknowledgedPerRequest,1);
    assert.equal(final.metrics.receivedBytes,fixture.expectedBytes);assert.equal(report.requests.filter(request=>request.page&&request.status===206).reduce((sum,request)=>sum+request.bytes,0),fixture.expectedBytes);
    report.cases.push({id:'native-page-bridge-window-control',windowMiB,delayMs:networkDelayMs,fixture,proof,metrics:final.metrics});await call('host','dispose');
  } else if (largeIO) {
    await call('coordinator','init',{id:'large-io',pageUrl:page.url(),sourceUrl:mediaOrigin+'/manifest.m3u8',idleMs:15000,requestMs:120000});
    const url=mediaOrigin+'/large-io.bin';await call('host','grant',{grants:[{url}]});await call('host','large-io',{url});
    let final;const samples=[];
    for(;;){final=await status();samples.push({at:Date.now(),metrics:final.metrics,bytes:final.work.large?.bytes});console.log(JSON.stringify(samples.at(-1)));if(final.work.large?.done)break;await sleep(10000);}
    // Status intentionally returns only bounded fields; read final seek proof separately.
    const proof=await call('host','large-proof');
    assert.equal(proof.error,undefined);assert.equal(proof.bytes,2**31+65537);assert.equal(proof.checked,proof.bytes);assert.equal(proof.fileSize,proof.bytes);assert.equal(proof.removed,true);
    assert.deepEqual(proof.slices.map(s=>s.bytes),[[90,90,90,90],[90,1,2,3,4,90],[90,90,90,90]]);
    assert.ok(final.metrics.maximumActive<=4);assert.ok(final.metrics.maximumQueuedBytes<=8388608);assert.equal(final.metrics.maximumUnacknowledgedPerRequest,1);
    assert.equal(final.metrics.receivedBytes,proof.bytes);assert.equal(report.requests.filter(r=>r.page&&r.status===206).reduce((n,r)=>n+r.bytes,0),proof.bytes);
    report.cases.push({id:'actual-over2GiB-transport-contiguous-OPFS-write-seek-patch-cleanup',scope:'Actual 2147549185 binary bytes, not a sparse file or large media remux',proof,metrics:final.metrics,samples});await call('host','dispose');
  } else if (fixRound1) {
    await page.goto(pageOrigin+'/iframe-watch');const frame=await until(async()=>page.frames().find(f=>f.url()===embedOrigin+'/embed-player'),f=>!!f,'cross-origin iframe');
    const selected=await call('coordinator','init',{id:'iframe-active',pageUrl:page.url(),frameUrl:frame.url(),sourceUrl:mediaOrigin+'/manifest.m3u8',idleMs:15000,requestMs:120000});assert.ok(selected.frameId>0);assert.equal(selected.pageUrl,pageOrigin+'/iframe-watch');
    const accepted=await until(status,s=>s.acceptedSender?.documentId===selected.documentId,'actual iframe port sender');assert.equal(accepted.acceptedSender.frameId,selected.frameId);assert.equal(accepted.acceptedSender.url,frame.url());
    const stalledUrl=mediaOrigin+'/body-stall-iframe.jpg';await call('host','grant',{grants:[{url:stalledUrl}]});await call('host','fetch',{id:'iframe',url:stalledUrl});await until(status,s=>s.metrics.receivedBytes===32768&&!s.work.iframe.done,'active iframe bytes');
    const churn=await call('coordinator','churn128');assert.equal(churn.completed,128);assert.deepEqual(churn.replay,{ok:false,error:'download-attachment-invalid'});const retained=await status();assert.equal(retained.metrics.active,1);assert.equal(retained.work.iframe.done,false);
    const originalRequests=report.requests.filter(r=>r.url==='/body-stall-iframe.jpg'&&r.page);assert.equal(originalRequests.length,1);assert.equal(originalRequests[0].closed,undefined);assert.equal(originalRequests[0].origin,embedOrigin);
    const detachAt=Date.now(),detach=await call('coordinator','detach');assert.equal(detach.settled,true);await until(async()=>originalRequests[0],r=>!!r.closed,'retained original physical socket close');const settled=await until(status,s=>s.work.iframe.done&&s.metrics.active===0,'retained original settled');assert.equal(settled.metrics.queuedBytes,0);report.cases.push({id:'nonzero-frame-128-active-capability-retention',selected,acceptedSender:accepted.acceptedSender,churn,retained,detachAt,detach,settled});
    const oldAttachment=await control.evaluate(async()=> (await chrome.storage.session.get('attachment')).attachment);await frame.goto(embedOrigin+'/embed-replacement');
    const stale=await control.evaluate(async a=>{try{return {reply:await chrome.tabs.sendMessage(a.selection.tabId,{...a,expiresAt:Date.now()+10000},{frameId:a.selection.frameId,documentId:a.selection.documentId})};}catch(e){return {error:String(e.message||e)};}},oldAttachment);assert.match(stale.error,/Receiving end|Could not establish|No document/i);
    const current=await control.evaluate(async s=>chrome.webNavigation.getFrame({tabId:s.tabId,frameId:s.frameId}),selected);assert.notEqual(current.documentId,selected.documentId);await call('host','dispose');
    const replacement=await call('coordinator','init',{id:'iframe-replacement',pageUrl:page.url(),frameUrl:frame.url(),sourceUrl:mediaOrigin+'/manifest.m3u8',idleMs:2000,requestMs:8000});assert.equal(replacement.documentId,current.documentId);const result=await fetchOne('replacement','/iframe-replacement.jpg');assert.equal(result.work.replacement.bytes,900001);assert.equal(result.work.replacement.sum,112493070);report.cases.push({id:'iframe-stale-document-target-and-fresh-binding',oldDocument:selected.documentId,currentDocument:current.documentId,stale,replacement,result});await call('host','dispose');
  } else {
  await init('native-success');
  const binary = await fetchOne('binary', '/redirect.jpg'); assert.equal(binary.work.binary.bytes, 900001);assert.equal(binary.work.binary.sum,112493070); assert.equal(binary.work.binary.headers.mime, 'image/jpeg'); assert.equal(binary.work.binary.headers.url, mediaOrigin + '/binary-final.jpg?signature=exact%2Fquery');
  const range = await fetchOne('range', '/range.jpg', { range: 'bytes=10-19', grantRange: { start: 10, end: 19 } }); assert.equal(range.work.range.bytes, 10);assert.equal(range.work.range.sum,145); assert.equal(range.work.range.headers.status, 206); assert.equal(range.work.range.headers.range, 'bytes 10-19/900001');
  report.cases.push({ id: 'binary-range-redirect', result: range }); await call('host', 'dispose');

  await init('native-gzip');const gzipUrl=mediaOrigin+'/gzip.m3u8';await call('host','manifests',{urls:[gzipUrl]});await call('host','fetch',{id:'gzip',url:gzipUrl});const gzip=await until(status,s=>s.work.gzip.done,'decoded gzip manifest');assert.equal(gzip.work.gzip.bytes,22);assert.equal(gzip.work.gzip.error,undefined);assert.equal(gzip.work.gzip.headers.encoding,null);assert.notEqual(gzip.work.gzip.headers.length,'22');report.cases.push({id:'browser-decoded-gzip-manifest',result:gzip});await call('host','dispose');
  await init('native-gzip-limit');const largeGzipUrl=mediaOrigin+'/oversize-gzip.m3u8';await call('host','manifests',{urls:[largeGzipUrl]});await call('host','fetch',{id:'gzipLimit',url:largeGzipUrl});const gzipLimit=await until(status,s=>s.work.gzipLimit.done,'decoded gzip manifest bound');assert.match(gzipLimit.work.gzipLimit.error,/body-limit/);assert.equal(gzipLimit.metrics.active,0);assert.equal(gzipLimit.metrics.queuedBytes,0);report.cases.push({id:'decoded-gzip-manifest2MiB-limit',result:gzipLimit});await call('host','dispose');

  for (const [id, suffix, expected] of [['cors', '/cors-deny.jpg', /fetch|Failed|network/i], ['range-bad', '/range-bad.jpg', /range/], ['headers', '/headers-stall.jpg', /timeout/], ['body', '/body-stall.jpg', /timeout/], ['retry', '/retry.jpg', /503/]]) {
    await init('native-' + id, 400); const result = await fetchOne(id, suffix, id === 'range-bad' ? { range: 'bytes=10-19', grantRange: { start: 10, end: 19 } } : {}); assert.match(result.work[id].error, expected); assert.ok(result.metrics.attempts <= 3); report.cases.push({ id, result }); await call('host', 'dispose');
  }

  await init('native-abort');
  const slowUrl = mediaOrigin + '/slow-abort.jpg'; await call('host', 'grant', { grants: [{ url: slowUrl }] });
  for (let i = 0; i < 8; i++) await call('host', 'fetch', { id: 'slow' + i, url: slowUrl, pause: true });
  const paused = await until(status, s => Object.values(s.work).filter(w => w.headers).length === 4, 'four paused headers');
  await sleep(150); const abortAt = Date.now(); const aborted = await call('host', 'abort');
  await until(async () => report.requests.filter(r => r.url === '/slow-abort.jpg' && r.page), entries => entries.length === 4 && entries.every(r => r.closed), 'physical aborted sockets');
  assert.equal(aborted.active, 0); assert.equal(aborted.queuedBytes, 0); assert.ok(aborted.maximumActive <= 4); assert.ok(aborted.maximumQueuedBytes <= 8388608); assert.equal(aborted.maximumUnacknowledgedPerRequest, 1);
  report.cases.push({ id: 'delayed-consumer-physical-abort', paused, aborted, abortAt }); await call('host', 'dispose');

  await init('native-disconnect'); const dropUrl=mediaOrigin+'/body-stall-disconnect.jpg';await call('host','grant',{grants:[{url:dropUrl}]});await call('host','fetch',{id:'drop',url:dropUrl});await until(status,s=>!!s.work.drop.headers,'drop headers');
  await call('coordinator','drop');const dropped=await until(status,s=>s.work.drop.done,'port disconnect');assert.match(dropped.work.drop.error,/disconnected/);assert.equal(dropped.metrics.active,1);assert.equal(dropped.metrics.quarantined,1);
  const detach=await call('coordinator','detach');const again=await call('coordinator','detach');assert.equal(detach.settled,true);assert.deepEqual(again,detach);
  await until(async()=>report.requests.filter(r=>r.url==='/body-stall-disconnect.jpg'&&r.page),entries=>entries.length===1&&entries[0].closed,'disconnect socket closed');
  const settledDrop=await status();assert.equal(settledDrop.metrics.active,0);assert.equal(settledDrop.metrics.quarantined,0);report.cases.push({id:'port-disconnect-detach-idempotent',dropped,detach,settled:settledDrop});await call('host','dispose');

  await init('native-sw'); const swUrl = mediaOrigin + '/slow-sw.jpg'; await call('host', 'grant', { grants: [{ url: swUrl }] }); await call('host', 'fetch', { id: 'sw', url: swUrl });
  await until(status, s => !!s.work.sw.headers && !s.work.sw.done, 'live before SW stop');
  const cdp = await context.newCDPSession(control); const versions = new Map(); cdp.on('ServiceWorker.workerVersionUpdated', e => { for (const v of e.versions) versions.set(v.versionId, v); }); await cdp.send('ServiceWorker.enable');
  const version = await until(async () => [...versions.values()].find(v => v.scriptURL === worker.url() && v.runningStatus === 'running'), v => !!v, 'running SW version');
  await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  await until(async () => versions.get(version.versionId), v => v.runningStatus === 'stopped', 'real SW stopped');
  const stopped = { ...versions.get(version.versionId) };
  const targets=await (await fetch('http://127.0.0.1:'+port+'/json')).json();const hostTarget=targets.find(t=>t.url===('chrome-extension://'+extensionId+'/host.html'));assert.ok(hostTarget,'offscreen DevTools target');
  const hostSocket=new WebSocket(hostTarget.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{hostSocket.addEventListener('open',resolve,{once:true});hostSocket.addEventListener('error',reject,{once:true});});let commandId=0;
  const inspectHost=()=>new Promise((resolve,reject)=>{const id=++commandId;const listener=e=>{const r=JSON.parse(e.data);if(r.id!==id)return;hostSocket.removeEventListener('message',listener);if(r.error)reject(new Error(JSON.stringify(r.error)));else resolve(JSON.parse(r.result.result.value));};hostSocket.addEventListener('message',listener);hostSocket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression:'JSON.stringify(globalThis.__nativeStatus())',returnByValue:true}}));});
  const after = await until(inspectHost, s => s.work.sw.done, 'stream after stop without runtime messaging'); assert.equal(after.work.sw.bytes, 900001); assert.equal(after.work.sw.error, undefined);
  const completedWhileStopped={...versions.get(version.versionId)};assert.equal(completedWhileStopped.runningStatus,'stopped');hostSocket.close();
  await call('coordinator', 'wake'); const woke = await until(async () => [...versions.values()].find(v => v.scriptURL === worker.url() && v.runningStatus === 'running'), v => !!v, 'SW wake'); report.cases.push({ id: 'real-sw-stop-wake', stopped, completedWhileStopped, woke, result: after }); await call('host', 'dispose');

  await init('native-navigation'); const navUrl = mediaOrigin + '/body-stall-navigation.jpg'; await call('host', 'grant', { grants: [{ url: navUrl }] }); await call('host', 'fetch', { id: 'navigation', url: navUrl }); await until(status, s => !!s.work.navigation.headers, 'navigation headers'); await page.goto(pageOrigin + '/replacement');
  const navigated = await until(status, s => s.work.navigation.done, 'navigation error'); assert.match(navigated.work.navigation.error, /disconnected/); assert.equal(navigated.metrics.active, 1); assert.equal(navigated.metrics.quarantined, 1);
  await until(async () => report.requests.filter(r => r.url === '/body-stall-navigation.jpg' && r.page), entries => entries.every(r => r.closed), 'navigation socket close');
  // Native coordinator proves old document teardown before accepting any replacement work.
  const attachment = await control.evaluate(() => chrome.storage.session.get('attachment')); await call('host', 'confirm', { capability: attachment.attachment.capability }); const confirmed = await status(); assert.equal(confirmed.metrics.active, 0); report.cases.push({ id: 'navigation', result: navigated, confirmed });
  }
  report.ok = true;
} catch (error) { report.ok = false; report.errors.push(String(error.stack || error)); process.exitCode = 1; }
finally {
  if (context) await context.close(); if(observerExit)report.observerExit=await observerExit;for (const timer of timers) clearInterval(timer); for (const socket of sockets) socket.destroy(); await Promise.all([media, pages].map(server => new Promise(resolve => server.close(resolve))));
  await writeFile(path.join(output, 'evidence.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ok: report.ok, output, cases: report.cases.map(c => c.id), errors: report.errors }));
}
