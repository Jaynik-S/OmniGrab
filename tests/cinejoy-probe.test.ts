import test from 'node:test';
import assert from 'node:assert/strict';
import * as transitions from '../src/core/reducer.ts';
import { DetectionStore } from '../src/background/store.ts';
import { ManifestProbe } from '../src/background/manifest-probe.ts';
import { parseHls } from '../src/manifests/hls.ts';
import type { ProbeJob, Snapshot } from '../src/core/model.ts';

const master = 'https://cdn.test/hls/master.m3u8?sig=a%2Fb';
const preferred = 'https://cdn.test/hls/1080p/playlist.jpg';
const other = 'https://cdn.test/hls/720p/playlist.jpg';
const masterText = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2543000,RESOLUTION=1280x720\n720p/playlist.jpg\n#EXT-X-STREAM-INF:BANDWIDTH=5022000,RESOLUTION=1920x1080\n1080p/playlist.jpg\n';
const mediaText = '#EXTM3U\n#EXT-X-TARGETDURATION:2000\n#EXTINF:1594.78,\none.jpg\n#EXTINF:1594.781635,\ntwo.png\n#EXT-X-ENDLIST\n';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function start() {
  return transitions.ingest(transitions.navigate(transitions.emptySnapshot(), 7, 'https://page.test/watch', 1, 'doc'), {
    tabId: 7, frameId: 0, documentId: 'doc', url: master, method: 'resource', observedAt: 2,
  });
}
function memory(state: Snapshot) { return new DetectionStore({ load: async () => state, save: async () => {} }); }
function signalNetwork(state: Snapshot, statusCode = 200) {
  return transitions.ingest(state, { tabId: 7, frameId: 0, documentId: 'doc', url: master,
    method: 'network', mime: 'application/vnd.apple.mpegurl', statusCode });
}

test('a successful network signal retries a previously failed same-type manifest with a fresh instance', async () => {
  const initial = start();
  const store = memory(initial.state);
  await new ManifestProbe(store, async () => new Response('missing', { status: 404 })).enqueue(initial.probe!);
  const failed = await store.read();
  const retry = signalNetwork(failed);
  assert.ok(retry.probe, 'new successful HLS traffic must recover the prior failure');
  assert.equal(retry.state.tabs[7].media[master].status, 'observed');
  assert.notEqual(retry.probe.instance, initial.probe!.instance);
  assert.deepEqual(transitions.applyManifest(retry.state, initial.probe!, {type:'hls',variants:[],childUrls:[],segmentUrls:[],protected:false}), retry.state);
});

test('repeated resource inventory and worker wakes do not create automatic failure retry loops', async () => {
  const initial = start(); const store = memory(initial.state); let calls = 0;
  const fetcher = async () => { calls++; return new Response('missing', {status:404}); };
  await new ManifestProbe(store, fetcher).enqueue(initial.probe!);
  let state = await store.read();
  for (let i=0;i<8;i++) {
    const repeated = transitions.ingest(state, {tabId:7,frameId:0,documentId:'doc',url:master,method:'resource'});
    assert.equal(repeated.probe, undefined); state = repeated.state;
  }
  await new ManifestProbe(memory(state), fetcher).recover();
  assert.equal(calls, 1);
});

test('explicit rescan requeues failed parent work durably and coalesces repeated rescans', async () => {
  const initial=start();const store=memory(initial.state);
  await new ManifestProbe(store, async()=>new Response('',{status:404})).recover();
  const retry = (transitions as unknown as {retryManifests?: (s:Snapshot,id:number)=>Snapshot}).retryManifests;
  assert.equal(typeof retry, 'function', 'Rescan needs a durable retry transition');
  const queued=retry!(await store.read(),7);
  assert.equal(queued.tabs[7].media[master].status,'observed');
  assert.deepEqual(retry!(queued,7),queued);
  const retried=memory(queued);
  await new ManifestProbe(retried,async()=>new Response(mediaText)).recover();
  assert.equal((await retried.read()).tabs[7].media[master].status,'confirmed');
  assert.equal((await retried.read()).tabs[7].media[master].duration,3189.561635);
});

test('fresh network failure recovery is bounded to three attempts until explicit rescan', async()=>{
  let result=start();let state=result.state;let calls=0;
  for(let i=0;i<6;i++) {
    if(result.probe){const store=memory(state);await new ManifestProbe(store,async()=>{calls++;return new Response('',{status:404});}).enqueue(result.probe);state=await store.read();}
    result=signalNetwork(state);state=result.state;
  }
  assert.equal(calls,3);
  assert.equal(result.probe,undefined);
});

test('master-only discovery enriches one preferred image-suffixed rendition and recovers its pending work',async()=>{
  const initial=start();const store=memory(initial.state);const urls:string[]=[];
  const probe=new ManifestProbe(store,async url=>{urls.push(String(url));return new Response(String(url)===master?masterText:mediaText);});
  await probe.enqueue(initial.probe!);
  await probe.recover();
  const state=await store.read();const item=state.tabs[7].media[master];
  assert.deepEqual(urls,[master,preferred]);
  assert.equal(item.duration,3189.561635);
  assert.equal(item.live,false);
  assert.equal(item.status,'confirmed');
  assert.deepEqual(Object.keys(state.tabs[7].media),[master]);
  assert.deepEqual(item.variants.map(v=>v.height),[720,1080]);
  assert.equal(item.childManifests?.find(c=>c.url===preferred)?.status,'confirmed');
  assert.ok(!urls.includes(other));
  assert.ok(!urls.some(url=>/one.jpg|two.png|key|init/.test(url)));
});

test('failed selected-child enrichment preserves its confirmed master and supports explicit retry',async()=>{
  const initial=start();const store=memory(initial.state);
  const probe=new ManifestProbe(store,async url=>String(url)===master?new Response(masterText):new Response('',{status:404}));
  await probe.enqueue(initial.probe!);await probe.recover();
  const item=(await store.read()).tabs[7].media[master];
  assert.equal(item.status,'confirmed');
  assert.equal(item.childManifests?.find(c=>c.url===preferred)?.status,'unresolved');
  const retry=(transitions as unknown as {retryManifests:(s:Snapshot,id:number)=>Snapshot}).retryManifests;
  const store2=memory(retry(await store.read(),7));
  await new ManifestProbe(store2,async()=>new Response(mediaText)).recover();
  assert.equal((await store2.read()).tabs[7].media[master].duration,3189.561635);
});

test('worker404 falls back to the normal page transport and preserves the redirected manifest base',async()=>{
  const initial=start();const store=memory(initial.state);const calls:string[]=[];
  const contextFetcher=async(job:ProbeJob,signal:AbortSignal)=>{
    calls.push(job.url);assert.equal(signal.aborted,false);
    const r=new Response(mediaText);Object.defineProperty(r,'url',{value:'https://redirect.test/final/playlist.jpg'});return r;
  };
  const probe=new ManifestProbe(store,async()=>new Response('',{status:404}),{contextFetcher} as never);
  await probe.enqueue(initial.probe!);
  const item=(await store.read()).tabs[7].media[master];
  assert.equal(item.status,'confirmed');
  assert.deepEqual(calls,[master]);
  assert.deepEqual(item.segmentUrls,['https://redirect.test/final/one.jpg','https://redirect.test/final/two.png']);
});

test('page fallback completion cannot resurrect a source after navigation',async()=>{
  const initial=start();const store=memory(initial.state);let answer!:(response:Response)=>void;let entered=false;
  const contextFetcher=async()=>{entered=true;return new Promise<Response>(resolve=>{answer=resolve;});};
  const pending=new ManifestProbe(store,async()=>new Response('',{status:404}),{contextFetcher} as never).enqueue(initial.probe!);
  await tick();assert.equal(entered,true);
  await store.dispatch(s=>transitions.navigate(s,7,'https://page.test/next',10,'new-doc'));
  answer(new Response(mediaText));await pending;
  assert.deepEqual(Object.keys((await store.read()).tabs[7].media),[]);
});

test('a successful image-MIME manifest response cannot cancel its pending body validation', async()=>{
  const initial=start();const store=memory(initial.state);
  const contextFetcher=async()=>{
    await store.dispatch(state=>transitions.ingest(state,{tabId:7,frameId:0,documentId:'doc',url:master,
      method:'network',statusCode:200,mime:'image/jpeg'}).state);
    return new Response(mediaText);
  };
  await new ManifestProbe(store,async()=>new Response('',{status:404}),{contextFetcher}).enqueue(initial.probe!);
  const item=(await store.read()).tabs[7].media[master];
  assert.equal(item.status,'confirmed','the parser must validate a manifest despite a misleading response MIME');
  assert.equal(item.duration,3189.561635);
});

test('two masters sharing a failed child retain separate work identities after rescan',()=>{
  let state=transitions.navigate(transitions.emptySnapshot(),7,'https://page.test/',1,'doc');
  const masters=['https://cdn.test/a.m3u8','https://cdn.test/b.m3u8'];
  const child='https://cdn.test/shared.jpg';
  for(const url of masters){
    const found=transitions.ingest(state,{tabId:7,frameId:0,documentId:'doc',url,method:'resource'});
    state=transitions.applyManifest(found.state,found.probe!,parseHls(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=1920x1080\n${child}\n`,url));
    const work=state.tabs[7].media[url].childManifests![0];
    state=transitions.probeFailed(state,{tabId:7,epoch:1,itemId:child,url:child,kind:'hls',instance:work.instance},'manifest-http:404');
  }
  state=transitions.retryManifests(state,7);
  const jobs=masters.map(ownerId=>({tabId:7,epoch:1,itemId:child,url:child,kind:'hls' as const,
    instance:state.tabs[7].media[ownerId].childManifests![0].instance,ownerId}));
  state=transitions.applyManifest(state,jobs[0],parseHls(mediaText,child));
  assert.equal(transitions.resolveProbeJob(state,jobs[1])?.item.id,masters[1]);
  state=transitions.applyManifest(state,jobs[1],parseHls(mediaText,child));
  assert.ok(masters.every(id=>state.tabs[7].media[id].childManifests![0].status==='confirmed'));
});

test('late grouping preserves exhausted child retry counts and the original failure reason',()=>{
  const child='https://cdn.test/exhausted.jpg';
  const found=transitions.ingest(transitions.navigate(transitions.emptySnapshot(),7,'https://page.test/',1,'doc'),
    {tabId:7,frameId:0,documentId:'doc',url:child,method:'network',mime:'application/vnd.apple.mpegurl',statusCode:200});
  let state=found.state;
  for(let i=0;i<3;i++)state=transitions.probeFailed(transitions.probeStarted(state,found.probe!),found.probe!,'manifest-http:404');
  const parent=transitions.ingest(state,{tabId:7,frameId:0,documentId:'doc',url:master,method:'resource'});
  state=transitions.applyManifest(parent.state,parent.probe!,parseHls(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\n${child}\n`,master));
  const work=state.tabs[7].media[master].childManifests![0];
  assert.equal(work.probeAttempts,3);
  assert.equal(work.reason,'manifest-http:404');
  const next=transitions.ingest(state,{tabId:7,frameId:0,documentId:'doc',url:child,method:'network',mime:'image/jpeg',statusCode:200});
  assert.equal(next.probe,undefined);
});

test('grouping a running standalone rendition coalesces its physical fetch instead of accepting a duplicate failure',async()=>{
  const child='https://cdn.test/running.jpg';
  const found=transitions.ingest(transitions.navigate(transitions.emptySnapshot(),7,'https://page.test/',1,'doc'),
    {tabId:7,frameId:0,documentId:'doc',url:child,method:'network',mime:'application/vnd.apple.mpegurl',statusCode:200});
  const store=memory(found.state);let answer!:(value:Response)=>void;let childCalls=0;
  const response=new Promise<Response>(resolve=>{answer=resolve;});
  const probe=new ManifestProbe(store,async url=>String(url)===child
    ? ++childCalls===1 ? response : new Response('',{status:404})
    : new Response(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=1920x1080\n${child}\n`));
  const running=probe.enqueue(found.probe!);await tick();
  let parentJob:ProbeJob|undefined;
  await store.dispatch(state=>{const next=transitions.ingest(state,{tabId:7,frameId:0,documentId:'doc',url:master,method:'resource'});parentJob=next.probe;return next.state;});
  await probe.enqueue(parentJob!);await tick();await tick();
  try {assert.equal(childCalls,1,'ownership transfer must not restart the same active rendition');}
  finally {answer(new Response(mediaText));await running;}
  await probe.recover();
  const item=(await store.read()).tabs[7].media[master];
  assert.equal(item.duration,3189.561635);assert.equal(item.childManifests![0].status,'confirmed');
});
