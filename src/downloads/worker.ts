import type { DownloadPlan, ResourceFetch } from './model.ts';
import { remuxToMp4 } from './remux.ts';
import { createOpfsOutput } from './opfs.ts';
import { OPFS_NAMESPACE } from './host-protocol.ts';
// A dedicated worker owns the exclusive synchronous OPFS writer; the host owns network IO.
const scope=self as unknown as {onmessage:((event:MessageEvent)=>void)|null;postMessage(message:unknown,transfer?:Transferable[]):void};
const lifetime=new AbortController();let counter=0;
setInterval(()=>scope.postMessage({type:'heartbeat'}),1000);
const pending=new Map<number,{resolve:(r:Response)=>void;reject:(e:unknown)=>void;signal:AbortSignal;abort:()=>void}>();
const fetcher:ResourceFetch=(input,init)=>new Promise((resolve,reject)=>{
 if(pending.size>=128){reject(Error('download-worker-request-limit'));return;}
 const id=++counter,signal=AbortSignal.any([lifetime.signal,...(init?.signal?[init.signal]:[])]);
 const abort=()=>{scope.postMessage({type:'abort-fetch',id});const p=pending.get(id);if(p){pending.delete(id);signal.removeEventListener('abort',abort);reject(signal.reason);}};
 if(signal.aborted){reject(signal.reason);return;}
 pending.set(id,{resolve,reject,signal,abort});signal.addEventListener('abort',abort,{once:true});
 scope.postMessage({type:'fetch',id,url:input instanceof Request?input.url:String(input),headers:[...new Headers(init?.headers)]});
});
function receiveResponse(data: {id:number;error?:string;body?:ReadableStream<Uint8Array>;status:number;headers:[string,string][];url:string}) {
 const p=pending.get(data.id);if(!p){void data.body?.cancel();return;}pending.delete(data.id);
 if(data.error){p.signal.removeEventListener('abort',p.abort);p.reject(Error('download-worker-fetch-failed'));return;}
 const reader=data.body?.getReader();const end=()=>p.signal.removeEventListener('abort',p.abort);
 const body=reader?new ReadableStream<Uint8Array>({async pull(c){try{const part=await reader.read();if(part.done){end();c.close();}else c.enqueue(part.value);}catch(e){end();c.error(e);}},async cancel(reason){end();p.abort();await reader.cancel(reason);}},{highWaterMark:0}):null;
 const response=new Response(body,{status:data.status,headers:data.headers});Object.defineProperty(response,'url',{value:data.url});p.resolve(response);
}
scope.onmessage=({data})=>{
 if(data.type==='response'){receiveResponse(data);return;}
 if(data.type==='cancel'){lifetime.abort(Error('download-canceled'));return;}
 if(data.type!=='run')return;
 void (async()=>{
  const directory=await (await navigator.storage.getDirectory()).getDirectoryHandle(OPFS_NAMESPACE,{create:true});
  const output=await createOpfsOutput(directory,data.tempFile);
  const result=await remuxToMp4(data.plan as DownloadPlan,{fetcher,output,signal:lifetime.signal,onProgress:progress=>scope.postMessage({type:'progress',progress})});
  scope.postMessage({type:'complete',result});
 })().catch(()=>scope.postMessage({type:'failed',error:'download-remux-failed'}));
};
