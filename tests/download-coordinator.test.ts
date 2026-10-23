import test from 'node:test';
import assert from 'node:assert/strict';
import { createDownloadCoordinator, trustedPopup } from '../src/downloads/coordinator.ts';
import { DownloadStore } from '../src/downloads/store.ts';
import type { DownloadJob, DownloadSelection, DownloadState } from '../src/downloads/model.ts';
import type { HostStatus } from '../src/downloads/host-protocol.ts';
const selection: DownloadSelection = { tabId: 1, epoch: 1, mediaId: 'media', instance: 1, pageUrl: 'https://page.test/', frameId: 2, documentId: 'doc', sourceUrl: 'https://media.test/master.m3u8', videoUrl: 'https://media.test/video.m3u8', filename: 'file.mp4', output: 'mp4' };
const request = (n = 1) => ({ requestId: 'request' + n, tabId: 1, epoch: 1, mediaId: 'media' + n, instance: 1 });
function fixture(initial?: DownloadState, restoreDelay = 0) {
 let durable = initial, fail = false, savingFailure = false, id = 0, valid = true, settled = true, holdCancel = false, failSearch = false;
 let notify: (() => void) | undefined;
 const saves: string[] = [], starts: string[] = [], downloads: Array<{ id: number; url: string; state: 'in_progress' | 'complete' | 'interrupted' }> = [];
 const hosts = new Map<string, HostStatus>();
 const store = new DownloadStore({ load: async () => {if(restoreDelay)await new Promise(r=>setTimeout(r,restoreDelay));return durable;}, save: async s => { if(fail || savingFailure && s.jobs.some(j=>j.phase==='saving')) throw Error('disk'); durable = structuredClone(s); saves.push(s.jobs.map(j => j.phase).join(','));notify?.(); } });
 const deps = { store, select: async (r: ReturnType<typeof request>) => ({ ...selection, mediaId: r.mediaId, sourceUrl: selection.sourceUrl + '?id=' + r.mediaId }), validate: async () => valid,
 host: { status: async () => [...hosts.values()], prepare: async (j: DownloadJob) => { assert.ok(durable?.jobs.find(x => x.id === j.id)?.attachment); starts.push(j.id); hosts.set(j.id,{jobId:j.id,phase:'resolving',started:true}); return {type:'download-attach' as const,jobId:j.id,capability:j.attachment!.capability,selection:j.selection,expiresAt:Date.now()+10000}; }, run: async () => {}, cancel: async () => {}, release: async (j: DownloadJob) => {hosts.delete(j.id);}, confirm: async () => {}, sweep: async () => {} },
 attach: async () => {}, detach: async () => settled,
 browser: { save: async (j: DownloadJob) => { assert.ok(durable?.jobs.find(x=>x.id===j.id)?.saveIntent); const item={id:++id,url:j.saveIntent!.objectUrl,state:'in_progress' as const};downloads.push(item);return item.id; }, search: async (j: DownloadJob) => {if(failSearch)throw Error('search failed');return downloads.filter(d=> j.browserDownloadId !== undefined ? d.id===j.browserDownloadId : d.url===j.saveIntent?.objectUrl);}, cancel: async (n:number) => { const d=downloads.find(d=>d.id===n);if(d&&!holdCancel)d.state='interrupted'; } }, uuid: () => 'job'+(++id), capability: () => 'a'.repeat(64), now: Date.now };
 const create = () => createDownloadCoordinator(deps); const coordinator = create();
 return { coordinator, create, store, hosts, downloads, starts, saves, onSave:(callback:()=>void)=>{notify=callback;}, fail: () => {fail=true;}, failSaving:()=>{savingFailure=true;}, recover: () => {fail=false;savingFailure=false;}, stale:()=>{valid=false;}, unsettled:()=>{settled=false;},holdCancel:()=>{holdCancel=true;},failSearch:()=>{failSearch=true;}, ready(id:string) { hosts.set(id,{jobId:id,phase:'ready-to-save',started:true,tempFile:id+'.mp4',objectUrl:'blob:chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'+id}); } };
}
test('durable start is idempotent and admits one active plus two queued', async()=>{
 const f=fixture(); const a=await f.coordinator.start(request()); assert.equal(a.ok,true); await f.coordinator.reconcile();
 const duplicate=await f.coordinator.start(request());assert.equal(duplicate.ok,true);if(duplicate.ok&&a.ok)assert.equal(duplicate.job.id,a.job.id);
 await f.coordinator.start(request(2));await f.coordinator.start(request(3));const full=await f.coordinator.start(request(4));assert.equal(full.ok,false);
 assert.equal(f.starts.length,1);assert.deepEqual((await f.store.read()).jobs.map(j=>j.phase),['resolving','queued','queued']);
});
test('failed durable start has no host side effect and stale validation rejects',async()=>{
 const f=fixture();f.fail();assert.equal((await f.coordinator.start(request())).ok,false);assert.equal(f.starts.length,0);
 const g=fixture();g.stale();assert.equal((await g.coordinator.start(request())).ok,false);assert.equal((await g.store.read()).jobs.length,0);
});
test('mux readiness is not completion; only actual browser completion finishes and releases',async()=>{
 const f=fixture();await f.coordinator.start(request());await f.coordinator.reconcile();const j=(await f.store.read()).jobs[0]!;f.ready(j.id);await f.coordinator.reconcile();
 assert.equal((await f.store.read()).jobs[0]!.phase,'saving');assert.equal(f.downloads.length,1);assert.equal(f.hosts.size,1);
 f.downloads[0]!.state='complete';await f.coordinator.reconcile();assert.equal((await f.store.read()).jobs[0]!.phase,'complete');assert.equal(f.hosts.size,0);
});
test('restart adopts live host without restarting and missing host interrupts',async()=>{
 const f=fixture();await f.coordinator.start(request());await f.coordinator.reconcile();await f.create().reconcile();assert.equal(f.starts.length,1);
 f.hosts.clear();await f.create().reconcile();assert.equal((await f.store.read()).jobs[0]!.phase,'interrupted');assert.equal(f.starts.length,1);
});
test('persisted intent recovers pre-ID completion even when host is lost, without another save',async()=>{
 const f=fixture();await f.coordinator.start(request());await f.coordinator.reconcile();const j=(await f.store.read()).jobs[0]!;f.ready(j.id);await f.coordinator.reconcile();
 await f.store.dispatch(s=>{delete s.jobs[0]!.browserDownloadId;s.jobs[0]!.phase='ready-to-save';return s;});f.hosts.clear();f.downloads[0]!.state='complete';
 await f.create().reconcile();assert.equal((await f.store.read()).jobs[0]!.phase,'complete');assert.equal(f.downloads.length,1);
});
test('uncertain save intent without matching transfer never replays',async()=>{
 const f=fixture();await f.coordinator.start(request());await f.coordinator.reconcile();const j=(await f.store.read()).jobs[0]!;f.ready(j.id);await f.coordinator.reconcile();f.downloads.length=0;
 await f.store.dispatch(s=>{delete s.jobs[0]!.browserDownloadId;s.jobs[0]!.phase='ready-to-save';return s;});await f.create().reconcile();assert.equal((await f.store.read()).jobs[0]!.phase,'interrupted');assert.equal(f.downloads.length,0);
});
test('cancel and retry cannot bypass unknown physical attachment settlement',async()=>{
 const f=fixture();await f.coordinator.start(request());await f.coordinator.reconcile();await f.coordinator.start(request(2));const j=(await f.store.read()).jobs[0]!;f.unsettled();
 assert.equal((await f.coordinator.cancel(j.id)).ok,false);await f.coordinator.reconcile();assert.equal(f.starts.length,1);assert.ok((await f.store.read()).jobs[0]!.attachment);
});
test('browser interruption is terminal and cleanup follows cancellation',async()=>{
 const f=fixture();await f.coordinator.start(request());await f.coordinator.reconcile();const j=(await f.store.read()).jobs[0]!;f.ready(j.id);await f.coordinator.reconcile();
 f.downloads[0]!.state='interrupted';await f.coordinator.reconcile();assert.equal((await f.store.read()).jobs[0]!.phase,'interrupted');assert.equal(f.hosts.size,0);
});
test('popup authority rejects content, foreign extension and other extension pages',()=>{
 const id='a'.repeat(32),url=`chrome-extension://${id}/popup/index.html`;
 assert.equal(trustedPopup({id,url},id,url),true);for(const sender of [{id,url,tab:{id:1}},{id:'b',url},{id,url:url+'?x'},{id,url:url.replace('popup/index','offscreen')}])assert.equal(trustedPopup(sender as chrome.runtime.MessageSender,id,url),false);
});
test('ID persistence failure leaves exact durable intent and restart recovers browser completion',async()=>{
 const f=fixture();await f.coordinator.start(request());await f.coordinator.reconcile();const j=(await f.store.read()).jobs[0]!;f.ready(j.id);f.failSaving();
 const failed=await f.coordinator.reconcile();assert.equal(failed.ok,false);assert.equal(f.downloads.length,1);assert.equal((await f.store.read()).jobs[0]!.browserDownloadId,undefined);assert.ok((await f.store.read()).jobs[0]!.saveIntent);
 f.downloads[0]!.state='complete';f.recover();await f.coordinator.reconcile();assert.equal((await f.store.read()).jobs[0]!.phase,'complete');assert.equal(f.downloads.length,1);
});
test('retry refuses an uncertain prior external save while resources remain retained',async()=>{
 const f=fixture();await f.coordinator.start(request());await f.coordinator.reconcile();const j=(await f.store.read()).jobs[0]!;f.ready(j.id);await f.coordinator.reconcile();f.downloads.length=0;await f.coordinator.reconcile();
 const retry=await f.coordinator.retry(j.id,'fresh-request');assert.equal(retry.ok,false);assert.equal(f.downloads.length,0);assert.equal((await f.store.read()).jobs.length,1);
});
test('snapshot reports reconciliation failure and cancellation waits for browser settlement',async()=>{
 const f=fixture();await f.coordinator.start(request());await f.coordinator.reconcile();const j=(await f.store.read()).jobs[0]!;f.ready(j.id);await f.coordinator.reconcile();f.holdCancel();
 const canceled=await f.coordinator.cancel(j.id);assert.equal(canceled.ok,false);assert.equal((await f.store.read()).jobs[0]!.phase,'saving');assert.equal(f.hosts.size,1);
 f.failSearch();const snapshot=await f.coordinator.snapshot();assert.equal(snapshot.ok,false);assert.ok(snapshot.error);
});
test('corrupt asynchronous restore blocks writes and host cleanup before any new start',async()=>{
 const f=fixture({version:2,jobs:[]} as unknown as DownloadState, 20);const start=await f.coordinator.start(request());assert.equal(start.ok,false);assert.equal(f.starts.length,0);assert.equal(f.saves.length,0);const snapshot=await f.coordinator.snapshot();assert.equal(snapshot.ok,false);
});
test('an unobserved save side effect retains its blob until exact browser settlement',async()=>{
 const f=fixture();await f.coordinator.start(request());await f.coordinator.reconcile();const j=(await f.store.read()).jobs[0]!;f.ready(j.id);await f.coordinator.reconcile();const browser=f.downloads.pop()!;
 await f.coordinator.reconcile();const uncertain=(await f.store.read()).jobs[0]!;assert.equal(uncertain.phase,'interrupted');assert.ok(uncertain.attachment);assert.ok(uncertain.tempFile);assert.equal(f.hosts.size,1);
 assert.equal((await f.coordinator.cancel(j.id)).ok,false);await f.coordinator.start(request(2));await f.coordinator.reconcile();assert.equal(f.starts.length,1);
 browser.state='complete';f.downloads.push(browser);await f.coordinator.reconcile();assert.equal((await f.store.read()).jobs[0]!.phase,'complete');assert.equal((await f.store.read()).jobs[0]!.attachment,undefined);
});
test('identical processing snapshots do not write or trigger storage-notification refresh loops',async()=>{
 const f=fixture();await f.coordinator.start(request());await f.coordinator.reconcile();const j=(await f.store.read()).jobs[0]!;
 f.hosts.set(j.id,{jobId:j.id,phase:'processing',started:true,progress:{phase:'processing',inputBytes:123,outputBytes:0}});
 let notifications=0;f.onSave(()=>{if(++notifications<5)void f.coordinator.snapshot();});const writes=f.saves.length;
 await f.coordinator.snapshot();for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));
 assert.equal(notifications,1);assert.equal(f.saves.length,writes+1);
 const updatedAt=(await f.store.read()).jobs[0]!.updatedAt;await f.coordinator.snapshot();await f.coordinator.snapshot();assert.equal(f.saves.length,writes+1);assert.equal((await f.store.read()).jobs[0]!.updatedAt,updatedAt);
});
test('restart interrupts a prepared but unstarted host and settles before any replacement',async()=>{
 const f=fixture();await f.coordinator.start(request());await f.coordinator.reconcile();const j=(await f.store.read()).jobs[0]!;
 f.hosts.set(j.id,{jobId:j.id,phase:'resolving',started:false} as HostStatus);
 await f.create().reconcile();const recovered=(await f.store.read()).jobs[0]!;assert.equal(recovered.phase,'interrupted');assert.equal(recovered.failure?.code,'download-bootstrap-interrupted');assert.equal(recovered.attachment,undefined);assert.equal(f.hosts.size,0);assert.equal(f.starts.length,1);
});
test('restart before attachment keeps prepared authority until the old document is proved settled',async()=>{
 const f=fixture();await f.coordinator.start(request());await f.coordinator.reconcile();const j=(await f.store.read()).jobs[0]!;
 f.hosts.set(j.id,{jobId:j.id,phase:'resolving',started:false} as HostStatus);f.unsettled();await f.create().reconcile();const recovered=(await f.store.read()).jobs[0]!;
 assert.equal(recovered.phase,'interrupted');assert.ok(recovered.attachment);assert.equal(recovered.failure?.code,'download-cleanup-pending');await f.coordinator.start(request(2));await f.coordinator.reconcile();assert.equal(f.starts.length,1);
});
