// Original native engine controls: real range/discontinuity media and a long packet stream.
// Worker OPFS output is streamed to disk, not returned as a whole-file JS buffer.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { fixtures, fixturePlan, scratch } from './download-fixtures.ts';
const output = path.resolve('.cache/download-acceptance-engine', `native-${Date.now()}-${process.pid}`);
await mkdir(output, { recursive: true });
const long = process.argv.includes('--long');
const muxCancel=process.argv.includes('--mux-cancel');
const report = { output, started: new Date().toISOString(), scope: 'Native engine + OPFS controls; not Chrome Downloads UI acceptance', cases: [], errors: [] };
if (!existsSync(path.join(scratch, 'mux720/list.m3u8'))) fixtures();
const sourceDirectory = path.join(output, 'source'); await mkdir(sourceDirectory);
if (long) {
  // Whole video-frame duration keeps the declared HLS duration and AAC endpoint aligned.
  const args = ['-v','error','-y','-f','lavfi','-i','color=c=blue:size=640x360:rate=2:duration=3190','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=3190','-c:v','libx264','-threads','1','-preset','ultrafast','-pix_fmt','yuv420p','-g','8','-c:a','aac','-b:a','32k','-ac','2','-f','hls','-hls_time','4','-hls_playlist_type','vod','-hls_segment_type','fmp4','-hls_segment_filename',path.join(sourceDirectory,'part%d.m4s'),path.join(sourceDirectory,'list.m3u8')];
  execFileSync('ffmpeg', args, { cwd: sourceDirectory, stdio: 'pipe' }); report.generation = { program: 'ffmpeg', args, exitCode: 0 };
}
const worker = await build({ stdin: { contents: `
import {remuxToMp4} from './src/downloads/remux.ts';import {createOpfsOutput} from './src/downloads/opfs.ts';let controller;
self.onmessage=async({data})=>{
 if(data.cancel){controller?.abort();return;}controller=new AbortController();let dir;
 try {dir=await navigator.storage.getDirectory();const disk=await createOpfsOutput(dir,'output.mp4');let highWater=0,patches=0,writes=0;
 const write=disk.write.bind(disk);disk.write=async(bytes,at)=>{if(++writes===2&&data.muxCancel){self.postMessage({muxReady:{position:at,length:bytes.length,alreadyWritten:highWater}});await new Promise(resolve=>setTimeout(resolve,1000));}if(at<highWater)patches++;await write(bytes,at);highWater=Math.max(highWater,at+bytes.length);};
 let last=0;const result=await remuxToMp4(data.plan,{output:disk,fetcher:fetch,signal:controller.signal,onProgress:p=>{if(Date.now()-last>1000){self.postMessage({progress:p});last=Date.now();}}});
 const file=await(await dir.getFileHandle('output.mp4')).getFile();const response=await fetch('/output/'+data.name,{method:'POST',body:file});if(!response.ok)throw Error('file-backed retention failed');
 const exclusive=await(await dir.getFileHandle('output.mp4')).createSyncAccessHandle();exclusive.close();await dir.removeEntry('output.mp4');
 self.postMessage({done:true,result,patches,fileSize:file.size,cleanup:true});
 }catch(e){if(data.muxCancel){const file=await dir.getFileHandle('output.mp4');const exclusive=await file.createSyncAccessHandle();exclusive.close();const size=(await file.getFile()).size;await dir.removeEntry('output.mp4');self.postMessage({done:true,aborted:controller.signal.aborted,errorName:e.name,closedSize:size,removed:true});}else self.postMessage({done:true,error:String(e.stack||e)});}
};`, loader:'ts', resolveDir:path.resolve('.') }, bundle:true, write:false, platform:'browser', format:'esm', target:'chrome120' });
report.workerSha256=createHash('sha256').update(worker.outputFiles[0].contents).digest('hex');
report.sourceHashes=Object.fromEntries(await Promise.all(['src/downloads/remux.ts','src/downloads/remux-source.ts','src/downloads/remux-validation.ts','src/downloads/opfs.ts'].map(async file=>[file,createHash('sha256').update(await readFile(file)).digest('hex')])));
const requests = []; const sockets = new Set(); let browser;
const server = createServer(async (req,res) => {
  try {
    const url = new URL(req.url, 'http://fixture.test');
    if(url.pathname === '/') { res.writeHead(200,{'content-type':'text/html'}).end('<!doctype html><title>Native acceptance engine</title>');return; }
    if(url.pathname === '/worker.js') { res.writeHead(200,{'content-type':'text/javascript'}).end(worker.outputFiles[0].contents);return; }
    if(req.method === 'POST' && /^\/output\/[a-z-]+$/.test(url.pathname)) { await pipeline(req,createWriteStream(path.join(output,path.basename(url.pathname)+'.mp4')));res.end('retained');return; }
    const root = url.pathname.startsWith('/long/') ? sourceDirectory : scratch;
    const file = path.resolve(root,'.'+(url.pathname.startsWith('/long/') ? url.pathname.slice(5) : url.pathname));
    if (!file.startsWith(path.resolve(root)+path.sep) || !existsSync(file)) { res.writeHead(404).end();return; }
    const size = (await stat(file)).size, match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range||'');
    const start = match ? Number(match[1]) : 0, end = match?.[2] ? Math.min(Number(match[2]),size-1) : size-1;
    if(start>end){res.writeHead(416).end();return;}
    requests.push({file:path.relative(root,file),start,end,bytes:end-start+1});
    res.writeHead(match?206:200,{'content-type':'application/octet-stream','content-length':end-start+1,...(match?{'content-range':`bytes ${start}-${end}/${size}`}:{})});
    const stream=createReadStream(file,{start,end});stream.pipe(res);res.once('close',()=>stream.destroy());stream.on('error',e=>res.destroy(e));
  }catch(error){res.writeHead(500).end(String(error));}
});
server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
try {
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??'C:/Users/jay03/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe',headless:true});
  report.browser=browser.version();
  const page=await browser.newPage();await page.goto(origin);
  for(const name of long?['long']:muxCancel?['mux-cancel']:['byte-range','discontinuity']) {
    let plan;
    if(long){const text=(await readFile(path.join(sourceDirectory,'list.m3u8'),'utf8')).replace(/URI="([^"]+)"/g,(_,uri)=>`URI="${origin}/long/${uri}"`).replace(/^(?!#)(\S+)$/gm,(_,uri)=>`${origin}/long/${uri}`);
      const {parseDownloadHls}=await import('../src/downloads/hls-plan.ts');const parsed=parseDownloadHls(text,origin+'/long/list.m3u8',origin+'/long/list.m3u8');
      plan={...fixturePlan(),duration:parsed.duration,manifests:[{url:origin+'/long/list.m3u8',text}],resources:parsed.resources};plan.selection={...plan.selection,videoUrl:origin+'/long/list.m3u8',width:640,height:360};
    } else {plan=JSON.parse(JSON.stringify(fixturePlan()).replaceAll('https://fixture.test',origin));
      if(name==='discontinuity')plan.manifests[0].text=plan.manifests[0].text.replace('#EXTINF:0.400000,\n'+origin+'/mux720/part1.m4s','#EXT-X-DISCONTINUITY\n#EXTINF:0.400000,\n'+origin+'/mux720/part1.m4s');
      else {const entries=['init.mp4','part0.m4s','part1.m4s','part2.m4s'];const buffers=entries.map(n=>readFileSync(path.join(scratch,'mux720',n)));await writeFile(path.join(scratch,'range-fixture.bin'),Buffer.concat(buffers));let cursor=0;const ranges=buffers.map(b=>{const start=cursor;cursor+=b.length;return{start,end:cursor-1};});
        const url=origin+'/range-fixture.bin';plan.resources=ranges.map(range=>({url,range}));plan.manifests[0].text=`#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:1\n#EXT-X-MAP:URI="${url}",BYTERANGE="${buffers[0].length}@0"\n`+ranges.slice(1).map((range,i)=>`#EXTINF:0.4,\n#EXT-X-BYTERANGE:${buffers[i+1].length}@${range.start}\n${url}`).join('\n')+'\n#EXT-X-ENDLIST';}
    }
    if(name==='discontinuity')assert.ok(plan.manifests[0].text.includes('#EXT-X-DISCONTINUITY'));
    const before=requests.length;const result=await page.evaluate(({name,plan,muxCancel})=>new Promise((resolve,reject)=>{const worker=new Worker('/worker.js',{type:'module'});let muxReady;worker.onerror=e=>{worker.terminate();reject(Error(e.message));};worker.onmessage=({data})=>{if(data.muxReady){muxReady=data.muxReady;worker.postMessage({cancel:true});return;}if(data.progress){window.latestProgress=data.progress;return;}if(data.done){worker.terminate();resolve({...data,...(muxReady?{muxReady}:{})});}};worker.postMessage({name,plan,muxCancel});}),{name,plan,muxCancel});
    if(muxCancel){assert.equal(result.aborted,true);assert.equal(result.errorName,'AbortError');assert.equal(result.removed,true);assert.ok(result.muxReady.alreadyWritten>0);report.cases.push({name,result,requests:requests.slice(before),scope:'Native engine cancellation during awaited mux output, not an end-to-end popup save claim'});continue;}
    assert.equal(result.error,undefined);assert.equal(result.cleanup,true);assert.ok(result.patches>0);
    const filename=path.join(output,name+'.mp4');const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-count_packets','-show_streams','-show_format','-of','json',filename],{encoding:'utf8'}));
    assert.deepEqual(probe.streams.map(t=>t.codec_name),['h264','aac']);assert.ok(Math.abs(Number(probe.format.duration)-plan.duration)<0.6);
    execFileSync('ffmpeg',['-v','error','-xerror','-i',filename,'-map','0:v:0','-map','0:a:0','-f','null','-'],{stdio:'pipe'});
    if(long){assert.ok(Number(probe.streams[0].nb_read_packets)>6000);assert.ok(Number(probe.streams[1].nb_read_packets)>140000);}
    const hash=createHash('sha256');for await(const chunk of createReadStream(filename))hash.update(chunk);
    report.cases.push({name,result,probe,sha256:hash.digest('hex'),requests:requests.slice(before),decodeExitCode:0});console.log(JSON.stringify({name,result,duration:probe.format.duration,packets:probe.streams.map(t=>t.nb_read_packets)}));
  }
  report.ok=true;
}catch(error){report.errors.push(error.stack??String(error));report.ok=false;process.exitCode=1;}
finally{await browser?.close();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));report.ended=new Date().toISOString();await writeFile(path.join(output,'evidence.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,output,errors:report.errors}));}
