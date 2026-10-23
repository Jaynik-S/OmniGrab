import type { DownloadJob, DownloadSelection, DownloadStartRequest } from './model.ts';
import type { DownloadHost } from './host-protocol.ts';
import type { DownloadAttachment } from './transport.ts';
import { DownloadStore, isTerminalPhase } from './store.ts';
export type JobOutcome = { ok: true; job: DownloadJob } | { ok: false; error: { code: string; message: string }; job?: DownloadJob };
export interface BrowserTransfer { id: number; url: string; state: 'in_progress' | 'complete' | 'interrupted'; }
export interface CoordinatorDependencies {
 store: DownloadStore; select(request: DownloadStartRequest): Promise<DownloadSelection>;
 validate(selection: DownloadSelection): Promise<boolean>; host: DownloadHost;
 attach(attachment: DownloadAttachment): Promise<void>; detach(job: DownloadJob): Promise<boolean>;
 browser: { save(job: DownloadJob): Promise<number>; search(job: DownloadJob): Promise<BrowserTransfer[]>; cancel(id: number): Promise<void> };
 uuid?: () => string; capability?: () => string; now?: () => number;
}
export function trustedPopup(sender: chrome.runtime.MessageSender, runtimeId: string, popupUrl: string): boolean {
 return sender.id === runtimeId && !sender.tab && sender.url === popupUrl;
}
/** Locks order metadata/lifecycle actions; the read-only document validator never takes this lock. */
export function createDownloadCoordinator(d: CoordinatorDependencies) {
 const now = d.now ?? Date.now, uuid = d.uuid ?? (() => crypto.randomUUID());
 let tail = Promise.resolve();
 const serial = <T>(work: () => Promise<T>): Promise<T> => { const next = tail.then(work); tail = next.then(()=>{},()=>{}); return next; };
 const error = (code: string, job?: DownloadJob): JobOutcome => ({ok:false,error:{code,message:code==='download-cleanup-pending'?'Close the original source tab to finish download cleanup.':code.replaceAll('-',' ')},...(job ? {job} : {})});
 const readJob = async (id: string) => (await d.store.read()).jobs.find(j=>j.id===id);
 async function patch(id: string, update: (job: DownloadJob) => void) {
  // All coordinator mutations hold serial(). Do not emit storage changes for a readonly refresh.
  const current=await readJob(id);if(!current)throw Error('download-job-missing');
  const next=structuredClone(current);update(next);
  if(JSON.stringify(next)===JSON.stringify(current))return current;
  next.updatedAt=Math.max(now(),next.createdAt);
  const state = await d.store.dispatch(s=>({...s,jobs:s.jobs.map(j=>j.id===id?next:j)}));return state.jobs.find(j=>j.id===id)!;
 }
 async function cleanup(job: DownloadJob): Promise<boolean> {
  await d.host.cancel(job.id);
  if(job.attachment) {
   if(!await d.detach(job)) {
    await patch(job.id,j=>{j.failure={code:'download-cleanup-pending',message:'Close the original source tab to finish download cleanup.'};});
    return false;
   }
   await d.host.confirm(job.id,job.attachment.capability);
   job=await patch(job.id,j=>{delete j.attachment;});
  }
  await d.host.release(job);
  await patch(job.id,j=>{delete j.tempFile;});return true;
 }
 async function finish(job: DownloadJob, phase: 'complete'|'failed'|'interrupted'|'canceled', code?: string) {
  job=await patch(job.id,j=>{j.phase=phase;if(code)j.failure={code,message:code.replaceAll('-',' ')};});
  return await cleanup(job);
 }
 async function browserState(job: DownloadJob): Promise<void> {
  const matches=await d.browser.search(job);
  if(matches.length!==1) {
   await patch(job.id,j=>{j.phase='interrupted';j.failure={code:'download-save-uncertain',message:'Chrome save outcome is unknown. Resources are retained until its exact transfer can be reconciled.'};});
   return;
  }
  const item=matches[0]!;
  if(job.browserDownloadId!==item.id)job=await patch(job.id,j=>{j.browserDownloadId=item.id;j.phase='saving';});
  if(item.state==='complete')await finish(job,'complete');
  else if(item.state==='interrupted')await finish(job,'interrupted','download-browser-interrupted');
 }
 async function reconcileInner() {
  let jobs=(await d.store.read()).jobs;
  if(d.store.error?.startsWith('Invalid or unavailable'))throw Error('download-metadata-unavailable');
  for(const job of jobs.filter(j=>isTerminalPhase(j.phase)&&j.failure?.code==='download-save-uncertain')) {
   const matches=await d.browser.search(job);
   if(matches.length!==1)return;
   const transfer=matches[0]!;
   const recovered=await patch(job.id,j=>{j.browserDownloadId=transfer.id;j.phase='saving';delete j.failure;});
   if(transfer.state==='complete')await finish(recovered,'complete');
   else if(transfer.state==='interrupted')await finish(recovered,'interrupted','download-browser-interrupted');
  }
  jobs=(await d.store.read()).jobs;
  // Unsettled old identities block all replacement IO, including after a host/browser restart.
  for(const job of jobs.filter(j=>isTerminalPhase(j.phase) && (j.attachment || j.tempFile)))if(!await cleanup(job))return;
  const statuses=await d.host.status();
  jobs=(await d.store.read()).jobs;
  const active=jobs.find(j=>!isTerminalPhase(j.phase)&&j.phase!=='queued');
  if(active) {
   if(active.saveIntent || active.browserDownloadId!==undefined)await browserState(active);
   else {
    const status=statuses.find(s=>s.jobId===active.id);
    if(!status)await finish(active,'interrupted','download-host-lost');
    else if(!status.started)await finish(active,'interrupted','download-bootstrap-interrupted');
    else if(status.phase==='failed')await finish(active,status.error==='download-worker-lost'?'interrupted':'failed',status.error ?? 'download-processing-failed');
    else if(status.phase==='ready-to-save' && status.objectUrl && status.tempFile) {
     const job=await patch(active.id,j=>{j.phase='ready-to-save';j.tempFile=status.tempFile;j.saveIntent={objectUrl:status.objectUrl!,attemptedAt:now()};if(status.progress)j.progress=status.progress;});
     // Intent is durable before the external side effect. Any uncertainty is reconciled, never replayed.
     let browserId: number;
     try {browserId=await d.browser.save(job);}catch {await browserState(job);return;}
     const saving=await patch(job.id,j=>{j.browserDownloadId=browserId;j.phase='saving';});
     await browserState(saving);
    } else if(status.progress || status.phase==='processing')await patch(active.id,j=>{j.phase=status.phase==='processing'?'processing':'resolving';if(status.progress)j.progress=status.progress;});
   }
  }
  jobs=(await d.store.read()).jobs;
  if(jobs.some(j=>!isTerminalPhase(j.phase)&&j.phase!=='queued'||isTerminalPhase(j.phase)&&j.attachment))return;
  const queued=jobs.find(j=>j.phase==='queued');
  if(!queued) {await d.host.sweep(jobs.flatMap(j=>j.tempFile?[j.tempFile]:[]));return;}
  if(!await d.validate(queued.selection)) {await finish(queued,'failed','download-stale-selection');return reconcileInner();}
  let job=await patch(queued.id,j=>{j.phase='resolving';j.tempFile=j.id+'.mp4';j.attachment={jobId:j.id,capability:d.capability?.() ?? crypto.randomUUID()+crypto.randomUUID(),tabId:j.selection.tabId,frameId:j.selection.frameId,documentId:j.selection.documentId};});
  try {const attachment=await d.host.prepare(job);await d.attach(attachment);await d.host.run(job.id);}
  catch {await finish(job,'failed','download-host-start-failed');}
 }
 const reconcile = () => serial(async()=>{try {await reconcileInner();return {ok:true as const,jobs:(await d.store.read()).jobs};}catch {return {ok:false as const,error:{code:'download-reconcile-failed',message:'Download reconciliation failed'},jobs:(await d.store.read()).jobs};}});
 const kick = () => {void reconcile();};
 async function start(request: DownloadStartRequest): Promise<JobOutcome> {
  const outcome=await serial(async(): Promise<JobOutcome>=>{
   try {
    const jobs=(await d.store.read()).jobs;
    if(d.store.error)return error('download-metadata-unavailable');
    const existing=jobs.find(j=>j.requestId===request?.requestId);if(existing)return {ok:true,job:existing};
    const selection=await d.select(request);if(!await d.validate(selection))return error('download-stale-selection');
    const same=jobs.find(j=>!isTerminalPhase(j.phase)&&j.selection.sourceUrl===selection.sourceUrl&&j.selection.videoUrl===selection.videoUrl&&j.selection.audioUrl===selection.audioUrl);if(same)return {ok:true,job:same};
    if(jobs.filter(j=>j.phase==='queued').length>=2)return error('download-queue-full');
    const time=now();const job: DownloadJob={version:1,id:uuid(),requestId:request.requestId,selection,phase:'queued',createdAt:time,updatedAt:time,progress:{phase:'processing',inputBytes:0,outputBytes:0}};
    await d.store.dispatch(s=>({...s,jobs:[...s.jobs,job]}));return {ok:true,job};
   }catch{return error('download-start-failed');}
  });if(outcome.ok)kick();return outcome;
 }
 async function cancel(id: string): Promise<JobOutcome> {
  const result=await serial(async():Promise<JobOutcome>=>{
   const job=await readJob(id);if(!job)return error('download-job-missing');
   try {
    if(job.failure?.code==='download-save-uncertain')return error('download-save-uncertain',job);
    if(job.saveIntent && !isTerminalPhase(job.phase)) {
     let items=await d.browser.search(job);
     if(items.length!==1)return error('download-save-uncertain',job);
     if(items[0]!.state==='in_progress') {
      await d.browser.cancel(items[0]!.id);
      items=await d.browser.search(job);
      if(items.length!==1||items[0]!.state==='in_progress')return error('download-browser-cancel-pending',job);
     }
     if(items[0]!.state==='complete') {
      if(!await finish(job,'complete'))return error('download-cleanup-pending',await readJob(id));
      return {ok:true,job:(await readJob(id))!};
     }
    }
    if(!isTerminalPhase(job.phase) && !await finish(job,'canceled','download-canceled'))return error('download-cleanup-pending',await readJob(id));
    else if(isTerminalPhase(job.phase) && !await cleanup(job))return error('download-cleanup-pending',await readJob(id));
    return {ok:true,job:(await readJob(id))!};
   }catch{return error('download-cancel-failed',job);}
  });kick();return result;
 }
 async function retry(id: string, requestId: string): Promise<JobOutcome> {
  try {
  const job=await readJob(id);if(!job||!isTerminalPhase(job.phase)||job.phase==='complete')return error('download-retry-invalid',job);
  if(job.attachment)return error('download-cleanup-pending',job);
  if(job.saveIntent) {
   const matches=await d.browser.search(job);
   if(matches.length!==1||matches[0]!.state!=='interrupted')return error('download-save-uncertain',job);
  }
  const s=job.selection;return start({requestId,tabId:s.tabId,epoch:s.epoch,mediaId:s.mediaId,instance:s.instance,variantId:s.requestedVariantId,filename:s.filename});
  }catch{return error('download-retry-failed');}
 }
 return {start,cancel,retry,reconcile,async snapshot(){return reconcile();}};
}
