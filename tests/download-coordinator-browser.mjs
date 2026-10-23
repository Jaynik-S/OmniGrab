// Production extension, owned media/origins/profile, actual Chrome Downloads and SW lifecycle.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir,mkdtemp,readFile,writeFile,cp } from 'node:fs/promises';
import { existsSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { fixtures,scratch } from './download-fixtures.ts';
const output=path.resolve('.cache/download-coordinator',`native-${Date.now()}-${process.pid}`);await mkdir(output,{recursive:true});
if(!existsSync(path.join(scratch,'mux720','list.m3u8')))fixtures();
const extension=path.join(output,'extension');await cp(path.resolve('dist'),extension,{recursive:true});
// Harness-only inspection and actual Worker.terminate fault injection; no production runtime route.
await writeFile(path.join(extension,'offscreen.js'),(await readFile(path.join(extension,'offscreen.js'),'utf8'))+'\nglobalThis.__fixtureStatus=()=>({status:session?.status,metrics:session?.transport.metrics,requests:session?.requests.size});globalThis.__fixtureTerminate=()=>session?.worker?.terminate();\n');
const report={started:new Date().toISOString(),output,cases:[],requests:[],errors:[]};let context,origin,slow=false,pageOnly=false,broken=false;const sockets=new Set(),timers=new Set();
const server=createServer((req,res)=>{
 const url=new URL(req.url,'http://fixture.test');const entry={path:url.pathname,range:req.headers.range,start:Date.now(),bytes:0,page:!!req.headers.referer?.startsWith(origin)};report.requests.push(entry);res.on('close',()=>{entry.closed=Date.now();entry.incomplete=!res.writableFinished;});
 if(url.pathname==='/replacement'){res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Replacement document</title>');return;} if(url.pathname==='/watch'){res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Owned coordinator fixture</title><video src="/master.m3u8"></video>');return;}
 if(url.pathname==='/master.m3u8'){res.writeHead(200,{'content-type':'application/vnd.apple.mpegurl'});res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"\n/'+(broken?'silent720':'mux720')+'/list.m3u8\n');return;}
 if(pageOnly&&url.pathname.endsWith('.m4s')&&!entry.page){entry.status=403;res.writeHead(403,{'content-length':0}).end();return;}
 const filename=path.resolve(scratch,'.'+url.pathname);if(!filename.startsWith(path.resolve(scratch)+path.sep)||!existsSync(filename)){res.writeHead(404).end();return;}
 let bytes=readFileSync(filename);if(url.pathname.endsWith('.m3u8'))bytes=Buffer.from(bytes.toString().replace('#EXT-X-TARGETDURATION:0','#EXT-X-TARGETDURATION:1'));
 const match=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range||'');const start=match?Number(match[1]):0,end=match?Math.min(Number(match[2]),bytes.length-1):bytes.length-1;
 entry.status=match?206:200;res.writeHead(match?206:200,{'content-type':url.pathname.endsWith('.m3u8')?'application/vnd.apple.mpegurl':'image/jpeg','content-length':end-start+1,'accept-ranges':'bytes','cache-control':'no-store',...(match?{'content-range':`bytes ${start}-${end}/${bytes.length}`}:{})});
 const send=()=>{entry.bytes=end-start+1;res.end(bytes.subarray(start,end+1));};
 if(slow&&url.pathname.endsWith('.m4s')){res.flushHeaders();let cursor=start;const timer=setInterval(()=>{const next=Math.min(cursor+8192,end+1);res.write(bytes.subarray(cursor,next));entry.bytes+=next-cursor;cursor=next;if(cursor>end){clearInterval(timer);timers.delete(timer);res.end();}},200);timers.add(timer);res.once('close',()=>{clearInterval(timer);timers.delete(timer);});}else send();
});server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function connectTarget(port,url){
 const target=await until(async()=> (await(await fetch('http://127.0.0.1:'+port+'/json')).json()).find(t=>t.url===url),Boolean,'DevTools target');
 const socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',j,{once:true});});let id=0;
 const send=(method,params={})=>new Promise((resolve,reject)=>{if(socket.readyState!==1){reject(Error('DevTools target closed'));return;}const timeout=setTimeout(()=>reject(Error('DevTools command timeout '+method)),10000);const n=++id;const listener=e=>{const value=JSON.parse(e.data);if(value.id!==n)return;socket.removeEventListener('message',listener);clearTimeout(timeout);value.error?reject(Error(JSON.stringify(value.error))):resolve(value.result);};socket.addEventListener('message',listener);socket.send(JSON.stringify({id:n,method,params}));});
 return {send,get closed(){return socket.readyState!==1;},close:()=>socket.close(),async evaluate(fn,arg){const result=await send('Runtime.evaluate',{expression:'('+fn.toString()+')('+JSON.stringify(arg)+')',awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;}};
}
async function until(fn,predicate,label,timeout=30000){const end=Date.now()+timeout;let last;while(Date.now()<end){last=await fn();if(predicate(last))return last;await sleep(50);}throw Error('Timeout '+label+': '+JSON.stringify(last));}
try{
 const profile=await mkdtemp(path.join(tmpdir(),'owned-download-coordinator-'));report.profile=profile;
 context=await chromium.launchPersistentContext(profile,{executablePath:process.env.CHROMIUM_PATH??'C:/Users/jay03/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--remote-debugging-port=0']});
 const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');const id=new URL(worker.url()).hostname;report.extensionId=id;report.browser=context.browser()?.version();
 const port=Number((await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);assert.notEqual(port,9222);report.debuggingPort=port;
 const monitor=context.pages()[0]; const cdp=await context.newCDPSession(monitor);await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:output});
 const page=await context.newPage();await page.goto(origin+'/watch');
 const bootstrap=await connectTarget(port,worker.url());await bootstrap.evaluate(()=>chrome.action.openPopup());bootstrap.close();let popup=await connectTarget(port,`chrome-extension://${id}/popup/index.html`);
 const tabId=await popup.evaluate(async url=>(await chrome.tabs.query({})).find(t=>t.url===url).id,page.url());
 const openPopup=async()=>{const wake=await context.newPage();await wake.goto('chrome-extension://'+id+'/popup/index.html');await wake.close();const boot=await connectTarget(port,worker.url());await boot.evaluate(()=>chrome.action.openPopup());boot.close();popup=await connectTarget(port,'chrome-extension://'+id+'/popup/index.html');};
 const call=async message=>{if(popup.closed)await openPopup();return popup.evaluate(m=>chrome.runtime.sendMessage(m),message);};
 const detected=await until(()=>call({type:'snapshot',tabId}),r=>Object.values(r.tab?.media??{}).some(m=>m.type==='hls'&&m.status==='confirmed'),'actual detector confirmed');
 const media=Object.values(detected.tab.media).find(m=>m.url===origin+'/master.m3u8'&&m.status==='confirmed');assert.ok(media,JSON.stringify(detected));
 const start=async(requestId)=>{const r=await call({type:'download-start',request:{requestId,tabId,epoch:detected.tab.epoch,mediaId:media.id,instance:media.instance??0,filename:requestId+'.mp4'}});assert.equal(r.ok,true,JSON.stringify(r));return r.job;};
 const snapshot=()=>call({type:'download-snapshot'});
 const done=async id=>until(snapshot,r=>r.jobs?.find(j=>j.id===id&&['complete','failed','interrupted','canceled'].includes(j.phase)),'terminal job',60000);
 const first=await start('native-complete');const complete=await done(first.id);const completed=complete.jobs.find(j=>j.id===first.id);assert.equal(completed.phase,'complete',JSON.stringify(complete));
 const item=await popup.evaluate(async id=>(await chrome.downloads.search({id}))[0],completed.browserDownloadId);assert.equal(item.state,'complete');assert.equal(item.byExtensionId,id);assert.ok(existsSync(item.filename));
 const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',item.filename],{encoding:'utf8'}));assert.deepEqual(probe.streams.map(t=>t.codec_name),['h264','aac']);assert.equal(probe.streams[0].height,720);assert.ok(Math.abs(Number(probe.format.duration)-1.2)<0.1);execFileSync('ffmpeg',['-v','error','-xerror','-i',item.filename,'-f','null','-'],{stdio:'pipe'});
 report.cases.push({id:'actual-chrome-download-complete',job:completed,browser:item,probe:{duration:probe.format.duration,tracks:probe.streams.map(t=>({codec:t.codec_name,height:t.height,channels:t.channels,frames:t.nb_frames}))},decode:'ffmpeg -xerror exit 0'});
 console.log('Actual Chrome save + ffprobe + decode passed',item.filename);

 let host=await connectTarget(port,'chrome-extension://'+id+'/offscreen.html');
 const hostState=()=>host.evaluate(()=>globalThis.__fixtureStatus());
 const files=()=>host.evaluate(async()=>{const dir=await(await navigator.storage.getDirectory()).getDirectoryHandle('media-downloads-v1');const names=[];for await(const [name]of dir.entries())names.push(name);return names;});
 assert.deepEqual(await files(),[]);
 const versions=new Map();cdp.on('ServiceWorker.workerVersionUpdated',e=>{for(const v of e.versions)versions.set(v.versionId,v);});await cdp.send('ServiceWorker.enable');
 slow=true;pageOnly=true;console.log('Starting stop/wake control');const before=report.requests.length;const second=await start('native-stop-wake');
 await until(hostState,s=>s.status?.phase==='processing'&&s.metrics?.receivedBytes>500&&s.metrics.active>0,'worker stream started');
 console.log('Streaming; closing action popup');await popup.evaluate(()=>{setTimeout(()=>window.close(),50);return true;});await sleep(100);popup.close();
 const version=await until(async()=>[...versions.values()].find(v=>v.scriptURL===worker.url()&&v.runningStatus==='running'),Boolean,'running SW');
 console.log('Stopping service worker');await cdp.send('ServiceWorker.stopWorker',{versionId:version.versionId});await until(async()=>versions.get(version.versionId),v=>v?.runningStatus==='stopped','stopped SW');const stopped={...versions.get(version.versionId)};
 const bytesBefore=(await hostState()).metrics.receivedBytes;
 const during=await until(hostState,s=>s.metrics?.receivedBytes>bytesBefore+8192,'bytes while actual SW stopped');const whileStreaming={...versions.get(version.versionId)};assert.equal(whileStreaming.runningStatus,'stopped');
 // A new control message explicitly wakes the coordinator. Existing worker is adopted.
 await openPopup();
 const after=await done(second.id);assert.equal(after.jobs.find(j=>j.id===second.id).phase,'complete',JSON.stringify(after));
 const physical=report.requests.slice(before).filter(r=>r.range==='bytes=0-262143'&&r.status===206);assert.equal(physical.length,4);assert.equal(new Set(physical.map(r=>r.path)).size,4);
 const saves=await popup.evaluate(async()=>chrome.downloads.search({}));assert.equal(saves.filter(s=>s.byExtensionId===id).length,2);
 report.cases.push({id:'popup-closure-real-sw-stop-wake-no-replay',jobId:second.id,stopped,whileStreaming,during,physicalRequests:physical.length,browserSaves:saves.length});console.log('Actual popup closure + stopped SW streaming + wake/no duplicate passed');
 const third=await start('native-cancel');await until(hostState,s=>s.status?.jobId===third.id&&s.status.phase==='processing'&&s.metrics.active>0,'cancel active stream');
 const cancelAt=Date.now();const canceled=await call({type:'download-cancel',jobId:third.id});assert.equal(canceled.ok,true,JSON.stringify(canceled));assert.equal(canceled.job.phase,'canceled');assert.equal(canceled.job.attachment,undefined);assert.deepEqual(await files(),[]);assert.equal((await hostState()).status,undefined);
 const interruptedSocket=report.requests.find(r=>r.start<cancelAt&&r.closed>=cancelAt&&r.incomplete&&r.range==='bytes=0-262143');assert.ok(interruptedSocket);report.cases.push({id:'native-cancel-physical-socket-opfs-cleanup',job:canceled.job,cancelAt,interruptedSocket});console.log('Actual worker cancellation + physical socket + OPFS cleanup passed');

 slow=false;pageOnly=false;broken=true;const bad=await start('native-missing-audio');const badState=await done(bad.id);assert.equal(badState.jobs.find(j=>j.id===bad.id).phase,'failed');assert.deepEqual(await files(),[]);broken=false;report.cases.push({id:'missing-audio-real-worker-error-cleanup',job:badState.jobs.find(j=>j.id===bad.id)});
 slow=true;pageOnly=true;const lost=await start('native-worker-lost');await until(hostState,s=>s.status?.jobId===lost.id&&s.status.phase==='processing'&&s.metrics.active>0,'worker before termination');const lostAt=Date.now();await host.evaluate(()=>globalThis.__fixtureTerminate());const lostState=await done(lost.id);const lostJob=lostState.jobs.find(j=>j.id===lost.id);assert.equal(lostJob.phase,'interrupted',JSON.stringify(lostJob));assert.equal(lostJob.failure.code,'download-worker-lost');assert.deepEqual(await files(),[]);report.cases.push({id:'silent-dedicated-worker-termination',lostAt,job:lostJob});console.log('Actual silently terminated worker detected + cleanup passed');
 const hostLost=await start('native-host-lost');await until(hostState,s=>s.status?.jobId===hostLost.id&&s.status.phase==='processing'&&s.metrics.active>0,'host before loss');await popup.evaluate(()=>chrome.offscreen.closeDocument());host.close();const hostLostState=await done(hostLost.id);assert.equal(hostLostState.jobs.find(j=>j.id===hostLost.id).phase,'interrupted');host=await connectTarget(port,'chrome-extension://'+id+'/offscreen.html');assert.deepEqual(await files(),[]);report.cases.push({id:'offscreen-loss-no-restart-cleanup',job:hostLostState.jobs.find(j=>j.id===hostLost.id)});
 slow=false;pageOnly=false;const fault=await connectTarget(port,worker.url());await fault.evaluate(()=>{const original=chrome.storage.local.set.bind(chrome.storage.local);chrome.storage.local.set=items=>items.downloadState?.jobs.some(j=>j.requestId==='native-id-save-crash'&&j.browserDownloadId!==undefined)?Promise.reject(Error('Owned fixture ID-save fault')):original(items);});fault.close();
 const crash=await start('native-id-save-crash');
 const external=await until(async()=>{if(popup.closed)await openPopup();return popup.evaluate(async()=>{const {downloadState}=await chrome.storage.local.get('downloadState');const job=downloadState.jobs.find(j=>j.requestId==='native-id-save-crash');return {job,items:job.saveIntent?await chrome.downloads.search({url:job.saveIntent.objectUrl}):[]};});},r=>r.items.length===1&&r.items[0].state==='complete','Chrome complete while ID persistence fails');assert.equal(external.job.browserDownloadId,undefined);assert.equal(external.job.phase,'ready-to-save');
 await popup.evaluate(()=>chrome.offscreen.closeDocument());host.close();
 const currentVersion=await until(async()=>[...versions.values()].find(v=>v.scriptURL===worker.url()&&v.runningStatus==='running'),Boolean,'precrash SW');await cdp.send('ServiceWorker.stopWorker',{versionId:currentVersion.versionId});await until(async()=>versions.get(currentVersion.versionId),v=>v.runningStatus==='stopped','save-boundary stopped SW');
 const recovered=await done(crash.id);const recoveredJob=recovered.jobs.find(j=>j.id===crash.id);assert.equal(recoveredJob.phase,'complete',JSON.stringify(recovered));assert.equal(recoveredJob.browserDownloadId,external.items[0].id);const matches=await popup.evaluate(async url=>chrome.downloads.search({url}),external.job.saveIntent.objectUrl);assert.equal(matches.length,1);host=await connectTarget(port,'chrome-extension://'+id+'/offscreen.html');assert.deepEqual(await files(),[]);report.cases.push({id:'real-ID-save-failure-plus-host-loss-plus-SW-restart-no-duplicate',before:external,after:recoveredJob,matches:matches.length});console.log('Actual Chrome save before durable ID + host/SW loss reconciled without duplicate');



 const hideSearch=await connectTarget(port,worker.url());await hideSearch.evaluate(()=>{const search=chrome.downloads.search.bind(chrome.downloads);chrome.downloads.search=query=>query.url||query.id!==undefined?Promise.resolve([]):search(query);globalThis.__fixtureRestoreSearch=()=>{chrome.downloads.search=search;};});hideSearch.close();
 const uncertain=await start('native-save-unobserved');const uncertainState=await done(uncertain.id);const uncertainJob=uncertainState.jobs.find(j=>j.id===uncertain.id);assert.equal(uncertainJob.failure.code,'download-save-uncertain');assert.ok(uncertainJob.attachment);assert.ok((await files()).includes(uncertainJob.tempFile));const held=await hostState();assert.equal(held.status.phase,'ready-to-save');assert.equal((await call({type:'download-cancel',jobId:uncertain.id})).ok,false);
 const actualHidden=await until(()=>popup.evaluate(async url=>chrome.downloads.search({url}),uncertainJob.saveIntent.objectUrl),r=>r.length===1&&r[0].state==='complete','actual hidden save complete');const reveal=await connectTarget(port,worker.url());await reveal.evaluate(()=>globalThis.__fixtureRestoreSearch());reveal.close();const revealed=await done(uncertain.id);assert.equal(revealed.jobs.find(j=>j.id===uncertain.id).phase,'complete');assert.deepEqual(await files(),[]);report.cases.push({id:'transient-empty-search-retains-native-blob-until-exact-settlement',uncertain:uncertainJob,held,actual:actualHidden[0],after:revealed.jobs.find(j=>j.id===uncertain.id)});console.log('Actual save with transient empty search retains native file, then reconciles exact settlement');
 const browserCancelHook=await connectTarget(port,worker.url());await browserCancelHook.evaluate(()=>{const listener=item=>{chrome.downloads.onCreated.removeListener(listener);void chrome.downloads.cancel(item.id);};chrome.downloads.onCreated.addListener(listener);});browserCancelHook.close();
 const saveCancel=await start('native-browser-interrupted');const interrupted=await done(saveCancel.id);const interruptedJob=interrupted.jobs.find(j=>j.id===saveCancel.id);const interruptedItem=await popup.evaluate(async id=>(await chrome.downloads.search({id}))[0],interruptedJob.browserDownloadId);report.browserInterruption={job:interruptedJob,item:interruptedItem};assert.equal(interruptedItem.state,'interrupted');assert.equal(interruptedJob.phase,'interrupted');assert.deepEqual(await files(),[]);report.cases.push({id:'actual-browser-interruption-before-ID-persistence',job:interruptedJob,item:interruptedItem});console.log('Actual Chrome onCreated cancellation reconciled as interrupted');
 slow=true;pageOnly=true;const navigation=await start('native-navigation');await until(hostState,s=>s.status?.jobId===navigation.id&&s.status.phase==='processing'&&s.metrics.active>0,'navigation active page IO');await page.goto(origin+'/replacement');const navState=await done(navigation.id);const navJob=navState.jobs.find(j=>j.id===navigation.id);assert.ok(navJob.attachment);assert.equal(navJob.failure.code,'download-cleanup-pending');assert.equal((await call({type:'download-cancel',jobId:navigation.id})).ok,false);
 await page.close();const cleared=await until(snapshot,r=>!r.jobs.find(j=>j.id===navigation.id)?.attachment,'closed original tab cleanup');assert.deepEqual(await files(),[]);report.cases.push({id:'navigation-quarantine-until-positive-closed-tab-proof',blocked:navJob,after:cleared.jobs.find(j=>j.id===navigation.id)});console.log('Navigation retains unknown physical identity; closed-tab proof releases cleanup');
 host.close();
 report.ok=true;
}catch(e){report.ok=false;report.errors.push(String(e.stack||e));process.exitCode=1;}
finally{await writeFile(path.join(output,'evidence.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,cases:report.cases.map(c=>c.id),errors:report.errors,evidence:path.join(output,'evidence.json')}));await context?.close();for(const timer of timers)clearTimeout(timer);for(const socket of sockets)socket.destroy();await new Promise(r=>server.close(r));}
