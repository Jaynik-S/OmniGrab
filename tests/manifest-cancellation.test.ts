import test from 'node:test';
import assert from 'node:assert/strict';
import { ManifestProbe } from '../src/background/manifest-probe.ts';
import { createPageManifestFetcher } from '../src/background/page-manifest.ts';
import { fetchManifestForPage } from '../src/content/manifest-fetch.ts';
import * as pageTransport from '../src/content/manifest-fetch.ts';
import { DetectionStore } from '../src/background/store.ts';
import { emptySnapshot, ingest, navigate } from '../src/core/reducer.ts';

test('an expired shared deadline refuses page network work before starting fetch',async()=>{
  let calls=0;
  const result=await fetchManifestForPage('https://cdn.test/master.m3u8',{
    expiresAt:Date.now()-1,fetcher:async()=>{calls++;return new Response('');},
  } as never);
  assert.equal(calls,0);
  assert.equal(result.ok,false);
});

test('late worker failures cannot leave orphan page fetches or exceed four physical page requests',async t=>{
  let state=navigate(emptySnapshot(),1,'https://page.test/',1,'doc');
  for(let i=0;i<8;i++)state=ingest(state,{tabId:1,frameId:0,documentId:'doc',url:`https://cdn.test/${i}.m3u8`,method:'resource'}).state;
  const store=new DetectionStore({load:async()=>state,save:async()=>{}});
  let active=0;let maximum=0;
  const controls=new Map<string,AbortController>();
  const chromeMock={webNavigation:{getFrame:async()=>({documentId:'doc',url:'https://page.test/',documentLifecycle:'active'})},tabs:{
    sendMessage:async(_id:number,message:{type:string;url:string;requestId:string;expiresAt?:number})=>{
      if(message.type==='cancel-manifest') {controls.get(message.requestId)?.abort(new Error('manifest-aborted'));return {ok:true};}
      const control=new AbortController();controls.set(message.requestId,control);
      const result=await fetchManifestForPage(message.url,{timeoutMs:150,expiresAt:message.expiresAt,signal:control.signal,
        fetcher:async(_url:RequestInfo|URL,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
          active++;maximum=Math.max(maximum,active);
          init!.signal!.addEventListener('abort',()=>{active--;reject(new Error('aborted'));},{once:true});
        })} as never);
      controls.delete(message.requestId);return result;
    },
  }};
  const original=Object.getOwnPropertyDescriptor(globalThis,'chrome');
  Object.defineProperty(globalThis,'chrome',{value:chromeMock,configurable:true});
  t.after(()=>{if(original)Object.defineProperty(globalThis,'chrome',original);else Reflect.deleteProperty(globalThis,'chrome');});
  const contextFetcher=createPageManifestFetcher(store);
  await new ManifestProbe(store,async()=>{await new Promise(resolve=>setTimeout(resolve,40));return new Response('',{status:404});},
    {timeoutMs:65,contextFetcher}).recover();
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(maximum<=4,`physical page requests exceeded four: ${maximum}`);
  assert.equal(active,0,'page requests must be physically aborted when the shared probe expires');
});

type Handler = (message: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => boolean | undefined;
function handler(fetcher: typeof fetch): Handler {
  const create=(pageTransport as unknown as {createManifestRequestHandler?:(id:string,options:{fetcher:typeof fetch})=>Handler}).createManifestRequestHandler;
  assert.equal(typeof create,'function','the real content message handler must own cancellation and deadline propagation');
  return create!('fixture',{fetcher});
}
const sender={id:'fixture',url:'chrome-extension://fixture/background.js'};
test('the real content handler cancels a running fetch on the matching background cancellation token',async()=>{
  let active=0;
  const receive=handler(async(_url,init)=>new Promise<Response>((_resolve,reject)=>{
    active++;init!.signal!.addEventListener('abort',()=>{active--;reject(new Error('aborted'));},{once:true});
  }));
  const result=new Promise<any>(resolve=>receive({type:'fetch-manifest',requestId:'cancel-me',url:'https://cdn.test/a.m3u8',expiresAt:Date.now()+1000},sender,resolve));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(active,1);
  receive({type:'cancel-manifest',requestId:'cancel-me'},sender,()=>{});
  assert.equal((await result).ok,false);assert.equal(active,0);
});

test('cancellation delivered before the fetch message prevents that request from starting',async()=>{
  let calls=0;const receive=handler(async()=>{calls++;return new Response('');});
  receive({type:'cancel-manifest',requestId:'arrived-early'},sender,()=>{});
  const result=await new Promise<any>(resolve=>receive({type:'fetch-manifest',requestId:'arrived-early',url:'https://cdn.test/a.m3u8',expiresAt:Date.now()+1000},sender,resolve));
  assert.equal(result.ok,false);assert.equal(calls,0);
});

test('the content message deadline is honored and cancellation from a page sender is rejected',async()=>{
  let aborted=false;
  const receive=handler(async(_url,init)=>new Promise<Response>((_resolve,reject)=>{
    init!.signal!.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));},{once:true});
  }));
  const result=new Promise<any>(resolve=>receive({type:'fetch-manifest',requestId:'short-deadline',url:'https://cdn.test/a.m3u8',expiresAt:Date.now()+25},sender,resolve));
  assert.equal(receive({type:'cancel-manifest',requestId:'short-deadline'},{id:'fixture',url:'https://page.test/',tab:{id:1} as chrome.tabs.Tab},()=>assert.fail('untrusted cancellation replied')),false);
  assert.equal((await result).ok,false);assert.equal(aborted,true);
});

test('restored jobs wait for old content capacity instead of becoming terminal failures after worker restart',async t=>{
  const oldReplies:((response:Response)=>void)[]=[];let calls=0;
  const receive=handler(async url=>{
    if(++calls<=4)return new Promise<Response>(resolve=>oldReplies.push(resolve));
    const response=new Response('#EXTM3U\n#EXTINF:3,\npart.ts\n#EXT-X-ENDLIST\n');
    Object.defineProperty(response,'url',{value:String(url)});return response;
  });
  let state=navigate(emptySnapshot(),1,'https://page.test/',1,'doc');
  for(let i=0;i<4;i++) {
    const url=`https://cdn.test/${i}.m3u8`;
    state=ingest(state,{tabId:1,frameId:0,documentId:'doc',url,method:'resource'}).state;
    receive({type:'fetch-manifest',requestId:`old-worker-${i}`,url,expiresAt:Date.now()+1000},sender,()=>{});
  }
  const chromeMock={webNavigation:{getFrame:async()=>({documentId:'doc',url:'https://page.test/',documentLifecycle:'active'})},tabs:{
    sendMessage:async(_id:number,message:unknown)=>new Promise(resolve=>receive(message,sender,resolve)),
  }};
  const previous=Object.getOwnPropertyDescriptor(globalThis,'chrome');
  Object.defineProperty(globalThis,'chrome',{value:chromeMock,configurable:true});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'chrome',previous);else Reflect.deleteProperty(globalThis,'chrome');});
  const store=new DetectionStore({load:async()=>state,save:async()=>{}});
  const recovering=new ManifestProbe(store,async()=>new Response('',{status:404}),{contextFetcher:createPageManifestFetcher(store)}).recover();
  for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));
  for(const answer of oldReplies){const response=new Response('#EXTM3U\n#EXTINF:3,\npart.ts\n#EXT-X-ENDLIST\n');Object.defineProperty(response,'url',{value:'https://cdn.test/old.m3u8'});answer(response);}
  await recovering;
  assert.ok(Object.values((await store.read()).tabs[1].media).every(item=>item.status==='confirmed'),
    'worker restoration must defer until surviving content requests release capacity');
});
