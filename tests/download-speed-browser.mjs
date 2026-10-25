// Matched complete generated HLS through unchanged built extensions and Chrome Downloads.
// node --experimental-strip-types tests/download-speed-browser.mjs --baseline=.cache/download-speed/baseline-dist
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { createInterface } from 'node:readline';
import { verifySavedReceipt, digestFrameRecords } from './download-speed-fixture.ts';
import { connectTarget } from './download-browser-cdp.mjs';
import { createPopupObserver } from './download-popup-observer.ts';

const option = (name, fallback) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const output = path.resolve(option('output', `.cache/download-speed/generated-${Date.now()}-${process.pid}`));
const fixture = path.resolve(option('fixture', '.cache/download-acceptance-engine/native-1792799751090-11308/source'));
const builds = [{ name:'baseline', directory:path.resolve(option('baseline','.cache/download-speed/baseline-dist')), identity:'b8b1671' },
  {name:'optimized',directory:path.resolve(option('optimized','dist')),identity:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()}];
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
const report = { started:new Date().toISOString(),pid:process.pid,output,fixture,scope:'Generated 640x360/2fps long packet HLS; not Cinejoy1080p',delayMs:25,cases:[],errors:[] };
await mkdir(output,{recursive:true});
async function hashFile(filename) { const hash=createHash('sha256');for await(const part of createReadStream(filename))hash.update(part);return hash.digest('hex'); }
async function hashes(directory,prefix='') { const result={};for(const entry of await readdir(directory,{withFileTypes:true})){const name=prefix+entry.name,file=path.join(directory,entry.name);if(entry.isDirectory())Object.assign(result,await hashes(file,name+'/'));else result[name]=await hashFile(file);}return result; }
async function until(fn,predicate,label,timeout=90000) { const deadline=Date.now()+timeout;let value;while(Date.now()<deadline){value=await fn();if(predicate(value))return value;await sleep(100);}throw Error(`${label}: ${JSON.stringify(value)}`); }
const manifest=await readFile(path.join(fixture,'list.m3u8'),'utf8');
assert.equal([...manifest.matchAll(/^#EXTINF:/gm)].length,798);
report.fixtureHashes=await hashes(fixture);
report.usefulMediaBytes=(await Promise.all(Object.keys(report.fixtureHashes).filter(name=>!name.endsWith('.m3u8')).map(async name=>(await stat(path.join(fixture,name))).size))).reduce((sum,n)=>sum+n,0);
let current,origin,context;const sockets=new Set(),cdpSockets=new Set();
const server=createServer(async(req,res)=>{
  try {
    const pathname=new URL(req.url,'http://fixture.test').pathname;
    if(pathname==='/watch'){res.writeHead(200,{'content-type':'text/html'}).end('<!doctype html><meta name="referrer" content="origin"><title>Generated long HLS</title><video preload="none" src="/master.m3u8"></video>');return;}
    if(pathname==='/master.m3u8'){res.writeHead(200,{'content-type':'application/vnd.apple.mpegurl'}).end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=40000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2"\n/hls/list.m3u8\n');return;}
    if(!pathname.startsWith('/hls/')){res.writeHead(404).end();return;}
    const name=pathname.slice(5);if(!Object.hasOwn(report.fixtureHashes,name)){res.writeHead(404).end();return;}
    const entry={name,range:req.headers.range,page:!!req.headers.referer?.startsWith(origin),started:Date.now(),bytes:0};
    if(current){current.requests.push(entry);current.active++;current.maximumActive=Math.max(current.maximumActive,current.active);}
    const owner=current;res.once('close',()=>{entry.closed=Date.now();entry.incomplete=!res.writableFinished;if(owner)owner.active--;});
    if(!name.endsWith('.m3u8')&&!entry.page){entry.status=404;res.writeHead(404,{'content-length':0}).end();return;}
    const file=path.join(fixture,name),size=(await stat(file)).size,match=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range??'');
    const start=match?Number(match[1]):0,end=match?.[2]?Math.min(Number(match[2]),size-1):size-1;
    if(start>end){entry.status=416;res.writeHead(416).end();return;}
    await sleep(report.delayMs);if(res.destroyed)return;
    entry.status=match?206:200;res.writeHead(entry.status,{'content-type':name.endsWith('.m3u8')?'application/vnd.apple.mpegurl':'application/octet-stream','content-length':end-start+1,'cache-control':'no-store',...(match?{'content-range':`bytes ${start}-${end}/${size}`}:{})});
    const stream=createReadStream(file,{start,end});stream.on('data',part=>{entry.bytes+=part.length;});stream.on('error',error=>res.destroy(error));res.once('close',()=>stream.destroy());stream.pipe(res);
  } catch(error) { res.destroy(error); }
});
server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
const save=()=>writeFile(path.join(output,'evidence.json'),JSON.stringify(report,null,2));
try {
  for(const build of builds){
    const directory=path.join(output,build.name);await mkdir(directory,{recursive:true});
    current={...build,artifactBefore:await hashes(build.directory),requests:[],active:0,maximumActive:0,samples:[],timing:{}};report.cases.push(current);
    assert.equal(Object.keys(current.artifactBefore).length,11);
    const profile=await mkdtemp(path.join(tmpdir(),'owned-download-speed-'));current.profile=profile;
    await mkdir(path.join(profile,'Default'),{recursive:true});await writeFile(path.join(profile,'Default','Preferences'),JSON.stringify({download:{default_directory:directory,prompt_for_download:false,directory_upgrade:true}}));
    context=await chromium.launchPersistentContext(profile,{executablePath:process.env.CHROMIUM_PATH??'C:/Users/jay03/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe',headless:true,acceptDownloads:false,args:[`--disable-extensions-except=${build.directory}`,`--load-extension=${build.directory}`,'--remote-debugging-port=0']});
    let ownedBrowserClosed=false;context.once('close',()=>{ownedBrowserClosed=true;});
    const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');const id=new URL(worker.url()).hostname;
    current.port=Number((await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);assert.notEqual(current.port,9222);
    current.browser=context.browser()?.version();await save();console.log(JSON.stringify({started:true,pid:process.pid,build:build.name,profile,port:current.port,receipt:path.join(output,'evidence.json')}));
    const page=await context.newPage(),cdp=await context.newCDPSession(page);
    await cdp.send('Browser.setDownloadBehavior',{behavior:'default',eventsEnabled:true});
    cdp.on('Browser.downloadWillBegin',()=>{current.timing.chromeBegin=Date.now();});
    cdp.on('Browser.downloadProgress',event=>{if(event.state==='completed')current.timing.chromeCompleted=Date.now();});
    await page.goto(origin+'/watch');
    await page.bringToFront();const boot=await connectTarget(current.port,worker.url(),cdpSockets);await boot.evaluate(()=>chrome.action.openPopup());boot.close();
    const popup=await connectTarget(current.port,`chrome-extension://${id}/popup/index.html`,cdpSockets);
    const call=message=>popup.evaluate(message=>chrome.runtime.sendMessage(message),message);
    const tabId=await popup.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url).id,page.url());
    const detected=await until(()=>call({type:'snapshot',tabId}),state=>Object.values(state.tab?.media??{}).some(media=>media.url===origin+'/master.m3u8'&&media.status==='confirmed'),'detector');
    const media=Object.values(detected.tab.media).find(media=>media.url===origin+'/master.m3u8'&&media.status==='confirmed');
    current.requests=[];current.maximumActive=current.active;current.timing.action=Date.now();
    const started=await call({type:'download-start',request:{requestId:'speed-'+build.name,tabId,epoch:detected.tab.epoch,mediaId:media.id,instance:media.instance??0,filename:'generated-long.mp4'}});assert.equal(started.ok,true,JSON.stringify(started));
    current.observation={errorCount:0,errors:[]};
    const observer=createPopupObserver({connection:popup,isAlive:()=>!ownedBrowserClosed,diagnostics:current.observation,onError:save,delay:()=>sleep(500),recover:async()=>{
      const boot=await connectTarget(current.port,worker.url(),cdpSockets);
      try{await boot.evaluate(()=>chrome.action.openPopup());}finally{boot.close();}
      return connectTarget(current.port,`chrome-extension://${id}/popup/index.html`,cdpSockets);
    }});
    for(;;){
      const state=await observer.evaluate(message=>chrome.runtime.sendMessage(message),{type:'download-snapshot'});
      const job=state.jobs.find(job=>job.id===started.job.id);const sample={at:Date.now(),phase:job?.phase,progress:job?.progress};current.samples.push(sample);
      if(job?.progress.inputBytes&&!current.timing.firstInput)current.timing.firstInput=sample.at;
      if(job?.progress.outputBytes&&!current.timing.firstOutput)current.timing.firstOutput=sample.at;
      if(['ready-to-save','saving','complete'].includes(job?.phase)&&!current.timing.mp4ReadyObserved)current.timing.mp4ReadyObserved=sample.at;
      if(job&&['complete','failed','canceled','interrupted'].includes(job.phase)){current.job=job;assert.equal(job.phase,'complete',JSON.stringify(job));break;}
      if(current.samples.length%40===0){await save();console.log(JSON.stringify({build:build.name,pid:process.pid,receipt:path.join(output,'evidence.json'),sample}));}await sleep(100);
    }
    current.download=await observer.evaluate(async id=>(await chrome.downloads.search({id}))[0],current.job.browserDownloadId);
    current.timing.chromeBegin??=Date.parse(current.download.startTime);current.timing.chromeCompleted??=Date.parse(current.download.endTime);
    current.chromeState=current.download.state;current.expectedBytes=current.job.progress.outputBytes;current.actualBytes=(await stat(current.download.filename)).size;verifySavedReceipt(current);
    current.sha256=await hashFile(current.download.filename);
    await sleep(500);current.cleanup=await observer.evaluate(async()=>{const root=await navigator.storage.getDirectory(),entries=[];for await(const [name,handle]of root.entries()){const files=[];if(handle.kind==='directory')for await(const [file]of handle.entries())files.push(file);entries.push({name,files});}return entries;});
    assert.ok(current.cleanup.every(entry=>entry.files.length===0));assert.equal(current.job.attachment,undefined);assert.equal(current.job.tempFile,undefined);
    current.artifactAfter=await hashes(build.directory);assert.deepEqual(current.artifactAfter,current.artifactBefore);
    current.successfulMediaBytes=current.requests.filter(req=>req.status===206&&!req.incomplete).reduce((sum,req)=>sum+req.bytes,0);current.byteAmplification=current.successfulMediaBytes/report.usefulMediaBytes;
    current.observability={progress:'100ms existing job snapshots; not raw worker message count',mp4Ready:'first ready/saving/complete state; Chrome begin is a tighter upper bound when available',cacheStagingQueue:'not exposed by unchanged production API; bounded assertions in native transport/window controls'};
    await context.close();context=undefined;await save();
    current.probe=JSON.parse(execFileSync('ffprobe',['-v','error','-count_packets','-show_streams','-show_format','-of','json',current.download.filename],{encoding:'utf8'}));
    assert.deepEqual(current.probe.streams.map(stream=>stream.codec_name),['h264','aac']);assert.equal(current.probe.streams[0].height,360);assert.equal(Number(current.probe.streams[1].nb_read_packets),149533);
    execFileSync('ffmpeg',['-v','error','-xerror','-i',current.download.filename,'-map','0:v:0','-map','0:a:0','-f','null','-'],{stdio:'pipe'});current.decodeExitCode=0;await save();
    current.contentHashes={};
    for(const mode of ['encoded','decoded']) {
      const filename=path.join(directory,mode+'-framehash.txt');
      execFileSync('ffmpeg',['-v','error','-xerror','-y','-i',current.download.filename,'-map','0:v:0','-map','0:a:0',...(mode==='encoded'?['-c','copy']:[]),'-f','framehash','-hash','sha256',filename],{stdio:'pipe'});
      current.contentHashes[mode]=await digestFrameRecords(createInterface({input:createReadStream(filename),crlfDelay:Infinity}));
    }
    await save();
  }
  assert.equal(report.cases[0].actualBytes,report.cases[1].actualBytes);
  assert.deepEqual(report.cases[0].contentHashes,report.cases[1].contentHashes,'encoded packet payload/timing and decoded A/V content must match; MP4 creation timestamps may differ');report.ok=true;
}catch(error){report.ok=false;report.errors.push(String(error.stack??error));process.exitCode=1;}
finally{for(const socket of cdpSockets)socket.close();await context?.close();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));report.ended=new Date().toISOString();await save();console.log(JSON.stringify({ok:report.ok,pid:process.pid,receipt:path.join(output,'evidence.json'),errors:report.errors}));}
