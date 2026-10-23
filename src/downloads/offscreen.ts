import { createDownloadTransport } from './transport.ts';
import { resolveDownloadPlan } from './plan.ts';
import { OPFS_NAMESPACE } from './host-protocol.ts';
import type { HostStatus } from './host-protocol.ts';
import type { DownloadJob } from './model.ts';
import { watchWorker } from './worker-watchdog.ts';
import { checkStorageBudget, safeStorageCode } from './storage.ts';
interface Session {
 job:DownloadJob;status:HostStatus;transport:ReturnType<typeof createDownloadTransport>;controller:AbortController;
 ready:Promise<void>;accept:()=>void;worker?:Worker;work?:Promise<void>;stopped?:Promise<void>;
 requests:Map<number,AbortController>;
}
let session:Session|undefined;
const directory=async()=> (await navigator.storage.getDirectory()).getDirectoryHandle(OPFS_NAMESPACE,{create:true});
const notify=()=>{void chrome.runtime.sendMessage({target:'download-coordinator',action:'changed'}).catch(()=>{});};
chrome.runtime.onConnect.addListener(port=>{
 const s=session;if(!s){port.disconnect();return;}
 void s.transport.acceptPort(port).then(accepted=>{if(accepted)s.accept();else port.disconnect();},()=>{port.disconnect();s.controller.abort();});
});
async function workerRun(s:Session,plan:Awaited<ReturnType<typeof resolveDownloadPlan>>) {
 const worker=new Worker(chrome.runtime.getURL('download-worker.js'),{type:'module'});s.worker=worker;
 await new Promise<void>((resolve,reject)=>{
  const abort=()=>{worker.postMessage({type:'cancel'});for(const controller of s.requests.values())controller.abort();};
  s.controller.signal.addEventListener('abort',abort,{once:true});
  let finished=false;
  const finish=(error?:Error)=>{if(finished)return;finished=true;monitor.dispose();s.controller.signal.removeEventListener('abort',abort);worker.terminate();s.worker=undefined;error?reject(error):resolve();};
  const monitor=watchWorker(()=>finish(Error('download-worker-lost')));
  worker.onerror=()=>finish(Error('download-worker-lost'));
  worker.onmessage=({data})=>{
   monitor.beat();if(data.type==='heartbeat')return;
   if(data.type==='progress'){s.status.progress=data.progress;return;}
   if(data.type==='complete'){if(!Number.isSafeInteger(data.result?.bytes)||data.result.bytes<=0){finish(Error('download-output-invalid'));return;}s.status.progress={phase:'finalizing',inputBytes:s.status.progress?.inputBytes??0,outputBytes:data.result.bytes,duration:data.result.duration};finish();return;}
   if(data.type==='failed'){finish(Error(safeStorageCode(data.error) ?? 'download-remux-failed'));return;}
   if(data.type==='abort-fetch'){s.requests.get(data.id)?.abort();return;}
   if(data.type!=='fetch'||!Number.isSafeInteger(data.id)||s.requests.has(data.id)||s.requests.size>=128){finish(Error('download-worker-protocol-invalid'));return;}
   const controller=new AbortController();s.requests.set(data.id,controller);
   void (async()=>{
    try {
     const response=await s.transport.fetch(data.url,{headers:data.headers,signal:AbortSignal.any([controller.signal,s.controller.signal])});
     const reader=response.body?.getReader();
     const body=reader?new ReadableStream<Uint8Array>({async pull(c){try{const p=await reader.read();if(p.done){s.requests.delete(data.id);c.close();}else c.enqueue(p.value);}catch(e){s.requests.delete(data.id);c.error(e);}},async cancel(reason){controller.abort();try{await reader.cancel(reason);}finally{s.requests.delete(data.id);}}},{highWaterMark:0}):null;
     worker.postMessage({type:'response',id:data.id,status:response.status,headers:[...response.headers],url:response.url,body},body?[body]:[]);
     if(!body)s.requests.delete(data.id);
    }catch {s.requests.delete(data.id);if(s.worker)worker.postMessage({type:'response',id:data.id,error:'download-fetch-failed'});}
   })();
  };
  worker.postMessage({type:'run',plan,tempFile:s.job.tempFile});if(s.controller.signal.aborted)abort();
 });
}
async function run(s:Session) {
 try {
  await Promise.race([s.ready,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error('download-attachment-timeout')),5000);void s.ready.then(()=>clearTimeout(timer));})]);
  s.controller.signal.throwIfAborted();
  const plan=await resolveDownloadPlan(s.job.selection,(input,init)=>{s.transport.grantManifests([input instanceof Request?input.url:String(input)]);return s.transport.fetch(input,init);},s.controller.signal);
  await checkStorageBudget(plan.estimatedMediaBytes,()=>navigator.storage.estimate());s.controller.signal.throwIfAborted();
  s.transport.grantResources(plan.resources);s.status.phase='processing';notify();
  await workerRun(s,plan);s.controller.signal.throwIfAborted();
  // Engine fulfillment guarantees flush + exclusive handle close before getFile().
  const file=await (await (await directory()).getFileHandle(s.job.tempFile!)).getFile();
  if(file.size!==s.status.progress?.outputBytes||file.size===0)throw Error('download-output-invalid');
  s.status.objectUrl=URL.createObjectURL(file);s.status.tempFile=s.job.tempFile;s.status.phase='ready-to-save';
 }catch(error){s.status.phase='failed';s.status.error=(error instanceof Error&&safeStorageCode(error.message))||(error instanceof Error&&error.message==='download-worker-lost'?'download-worker-lost':'download-processing-failed');}
 finally{notify();}
}
async function stop(s:Session) {
 if(s.stopped)return s.stopped;
 s.stopped=(async()=>{s.controller.abort();for(const controller of s.requests.values())controller.abort();await s.transport.abort();await s.work;})();return s.stopped;
}
async function command(m:Record<string,unknown>) {
 if(m.action==='status')return session?[structuredClone(session.status)]:[];
 if(m.action==='prepare'){
  const job=m.job as DownloadJob;if(session)throw Error('download-host-busy');if(!job.attachment||job.attachment.jobId!==job.id||!job.tempFile)throw Error('download-host-job-invalid');
  const transport=createDownloadTransport({jobId:job.id,selection:job.selection,validateDocument:async()=>{
   try {const result=await Promise.race([chrome.runtime.sendMessage({target:'download-coordinator',action:'validate',selection:job.selection}),new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('validation timeout')),5000))]);return result?.ok===true&&result.valid===true;}catch{return false;}
  }});
  let accept!:()=>void;const ready=new Promise<void>(resolve=>{accept=resolve;});
  session={job,status:{jobId:job.id,phase:'resolving',started:false},transport,controller:new AbortController(),ready,accept,requests:new Map()};return transport.expectAttachment(job.attachment.capability);
 }
 if(m.action==='sweep'){
  const retain=new Set(m.retained as string[]);if(session?.job.tempFile)retain.add(session.job.tempFile);
  const dir=await directory();for await(const [name] of (dir as unknown as {entries():AsyncIterableIterator<[string,FileSystemHandle]>}).entries())if(/^[a-zA-Z0-9_-]+\.mp4$/.test(name)&&!retain.has(name))await dir.removeEntry(name);return;
 }
 if(m.action==='release'){
  const job=m.job as DownloadJob;if(session?.job.id===job.id){await stop(session);await session.transport.dispose();if(session.status.objectUrl)URL.revokeObjectURL(session.status.objectUrl);session=undefined;}
  if(job.tempFile){try{await (await directory()).removeEntry(job.tempFile);}catch(e){if(!(e instanceof DOMException&&e.name==='NotFoundError'))throw e;}}return;
 }
 const s=session;if(!s||s.job.id!==m.jobId)return;
 if(m.action==='run'){if(!s.work){s.status.started=true;s.work=run(s);}return;}
 if(m.action==='cancel'){await stop(s);return;}
 if(m.action==='confirm'){s.transport.confirmAttachmentStopped(String(m.capability));return;}
 throw Error('download-host-command-invalid');
}
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
 if(m?.target!=='download-host')return;
 if(sender.id!==chrome.runtime.id||sender.tab||sender.url!==chrome.runtime.getURL('background.js')){reply({ok:false,error:'download-host-sender-invalid'});return;}
 void command(m).then(value=>reply({ok:true,value}),()=>reply({ok:false,error:'download-host-command-failed'}));return true;
});
