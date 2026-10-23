import type { DownloadJob, DownloadSelection } from './model.ts';
import type { Snapshot } from '../core/model.ts';
import { selectDownload } from './validation.ts';
import type { DownloadHost, HostStatus } from './host-protocol.ts';
import type { DownloadAttachment } from './transport.ts';
import type { BrowserTransfer } from './coordinator.ts';
export function createOffscreenManager(api: { contexts(): Promise<boolean>; create(): Promise<void> }) {
 let creating: Promise<void> | undefined;
 return { async ensure() { if(creating)return creating;creating=(async()=>{if(!await api.contexts())await api.create();})();try{await creating;}finally{creating=undefined;} } };
}
export function createBrowserDownloadAdapter(readDetection: () => Promise<Snapshot>, captureDocument: (selection: DownloadSelection) => () => boolean) {
 const hostUrl=chrome.runtime.getURL('offscreen.html');
 const exists=async()=> (await chrome.runtime.getContexts({contextTypes:[chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],documentUrls:[hostUrl]})).length>0;
 const manager=createOffscreenManager({contexts:exists,create:()=>chrome.offscreen.createDocument({url:'offscreen.html',reasons:[chrome.offscreen.Reason.WORKERS,chrome.offscreen.Reason.BLOBS],justification:'Remux selected HLS in a local worker and save its finalized file-backed MP4.'})});
 async function call<T>(action:string,fields:Record<string,unknown>={}):Promise<T> {
  const result=await chrome.runtime.sendMessage({target:'download-host',action,...fields});
  if(!result?.ok)throw Error('download-host-command-failed');return result.value as T;
 }
 const host: DownloadHost={
  status:async()=>await exists()?call<HostStatus[]>('status'):[],
  prepare:async job=>{await manager.ensure();return call<DownloadAttachment>('prepare',{job});},
  run:async jobId=>{await call('run',{jobId});},
  cancel:async jobId=>{if(await exists())await call('cancel',{jobId});},
  confirm:async(jobId,capability)=>{if(await exists())await call('confirm',{jobId,capability});},
  release:async job=>{await manager.ensure();await call('release',{job});},
  sweep:async retained=>{await manager.ensure();await call('sweep',{retained});},
 };
 async function validate(selection: DownloadSelection) {
  try {
   const current=captureDocument(selection);if(!current())return false;
   const state=await readDetection(),tab=state.tabs[selection.tabId],item=tab?.media[selection.mediaId];
   if(!tab||tab.epoch!==selection.epoch||tab.url!==selection.pageUrl||tab.documents[selection.frameId]!==selection.documentId||!item||item.url!==selection.sourceUrl||(item.instance??0)!==selection.instance||item.status!=='confirmed'||item.type!=='hls'||item.protected!==false||item.live===true||!item.documentIds.includes(selection.documentId))return false;
   const frame=await chrome.webNavigation.getFrame({tabId:selection.tabId,frameId:selection.frameId});
   return current() && frame?.documentId===selection.documentId && frame.documentLifecycle==='active';
  }catch{return false;}
 }
 return {host,validate,select:async(request: Parameters<typeof selectDownload>[1])=>selectDownload(await readDetection(),request),
  async attach(attachment: DownloadAttachment) {
   const s=attachment.selection;const receipt=await chrome.tabs.sendMessage(s.tabId,attachment,{frameId:s.frameId,documentId:s.documentId});if(!receipt?.ok)throw Error('download-attach-rejected');
  },
  async detach(job: DownloadJob) {
   const a=job.attachment;if(!a)return true;
   try {
    const receipt=await chrome.tabs.sendMessage(a.tabId,{type:'download-detach',jobId:a.jobId,capability:a.capability},{frameId:a.frameId,documentId:a.documentId});
    if(receipt?.ok&&receipt.settled===true&&receipt.jobId===a.jobId&&receipt.capability===a.capability)return true;
   }catch{/* A failed message alone is not proof of document teardown. */}
   // A missing current frame is not destruction proof (BFCache may retain it).
   // Only a successful full tab inventory proving the original tab closed can release quarantine.
   try {return !(await chrome.tabs.query({})).some(tab=>tab.id===a.tabId);}catch{return false;}
  },
  browser:{
   async save(job: DownloadJob) {
    if(!job.saveIntent?.objectUrl.startsWith('blob:'+chrome.runtime.getURL('')))throw Error('download-save-origin-invalid');
    return chrome.downloads.download({url:job.saveIntent.objectUrl,filename:job.selection.filename,conflictAction:'uniquify',saveAs:false});
   },
   async search(job: DownloadJob):Promise<BrowserTransfer[]> {
    if(!job.saveIntent)return [];
    const items=await chrome.downloads.search(job.browserDownloadId!==undefined?{id:job.browserDownloadId}:{url:job.saveIntent.objectUrl});
    return items.filter(item=>item.url===job.saveIntent!.objectUrl&&item.byExtensionId===chrome.runtime.id).map(item=>({id:item.id,url:item.url,state:item.state}));
   },
   async cancel(id:number){await chrome.downloads.cancel(id);},
  },
 };
}
