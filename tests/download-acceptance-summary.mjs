// Sanitized, reproducible metadata summary. No media bytes, cookies or capability tokens.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const directory=path.resolve(process.argv[2]);
const destination=path.resolve(process.argv[3]??path.join(directory,'summary.json'));
const receipt=JSON.parse(await readFile(path.join(directory,'receipt.json'),'utf8'));
const hash=text=>createHash('sha256').update(text).digest('hex');
const selected=receipt.selectedManifests.selected,master=receipt.selectedManifests.master;
const expected=selected.text.split(/\r?\n/).filter(line=>line&&!line.startsWith('#')).map(line=>new URL(line,selected.url).href);
const initializations=[...selected.text.matchAll(/#EXT-X-MAP:URI="([^"]+)"/g)].map(m=>new URL(m[1],selected.url).href);
const media=new Set([...expected,...initializations]);const objects=new Map();
for(const r of receipt.network??[]) {
  if(!media.has(r.url))continue;
  let entry=objects.get(r.url);if(!entry){entry={urlSha256:hash(r.url),requests:0,successfulRequests:0,bodyBytes:0,encodedBytes:0,ranges:[],errors:[]};objects.set(r.url,entry);}
  entry.requests++;
  if(r.error||!r.finished||![200,206].includes(r.status)){entry.errors.push({scope:r.scope,status:r.status,error:r.error,finished:!!r.finished});continue;}
  const match=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(r.contentRange??'');
  if(r.status===206)assert.ok(match,JSON.stringify(r));
  const start=match?Number(match[1]):0,total=match?Number(match[3]):Number(r.length),end=match?Number(match[2]):total-1;
  assert.ok(Number.isSafeInteger(total)&&total>0,'known complete resource size');
  if(entry.total!==undefined)assert.equal(entry.total,total,'source length changed');entry.total=total;
  assert.equal(Number(r.length),end-start+1);entry.successfulRequests++;entry.bodyBytes+=Number(r.length);entry.encodedBytes+=r.encodedBytes??0;entry.ranges.push({start,end});
}
for(const entry of objects.values()) {
  const merged=[];for(const r of entry.ranges.sort((a,b)=>a.start-b.start||a.end-b.end)){const last=merged.at(-1);if(last&&r.start<=last.end+1)last.end=Math.max(last.end,r.end);else merged.push({...r});}
  entry.coveredBytes=merged.reduce((n,r)=>n+r.end-r.start+1,0);entry.coverage=merged;entry.fullCoverage=entry.coveredBytes===entry.total;
  const grouped=new Map();for(const error of entry.errors){const key=JSON.stringify(error);grouped.set(key,(grouped.get(key)??0)+1);}
  entry.errors=[...grouped].map(([key,count])=>({...JSON.parse(key),count}));delete entry.ranges;
}
const samples=(await readFile(path.join(directory,'samples.ndjson'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
let resources=[];try{resources=(await readFile(path.join(directory,'resources.ndjson'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch{}
const values=field=>resources.flatMap(s=>[...new Map(s.heaps.map(h=>[h.targetId,h])).values()].filter(h=>h.url?.endsWith('/download-worker.js')&&typeof h[field]==='number').map(h=>h[field]));
const range=values=>values.length?{samples:values.length,first:values[0],min:Math.min(...values),max:Math.max(...values),last:values.at(-1)}:null;
const summaries=[...objects.values()],sourceBytes=summaries.reduce((n,o)=>n+(o.total??0),0),bodyBytes=summaries.reduce((n,o)=>n+o.bodyBytes,0);
const objectCoverageText=JSON.stringify(summaries,null,2);
await writeFile(path.join(directory,'object-coverage.json'),objectCoverageText);
const firstProgress=samples.find(s=>s.job?.progress.inputBytes>0),lastZero=samples.filter(s=>s.job&&s.job.progress.inputBytes===0).at(-1);
const completeCoverage=[...media].every(u=>objects.get(u)?.fullCoverage),bothContexts=receipt.networkScope==='page-and-offscreen';
const before=resources.filter(s=>Date.parse(s.at)<Date.parse(receipt.actionAt)),during=resources.filter(s=>Date.parse(s.at)>=Date.parse(receipt.actionAt));
const sum=(s,field)=>[].concat(s.memory).reduce((n,p)=>n+p[field],0);
const processMeasure=field=>{const baseline=before.length?sum(before.at(-1),field):null,active=during.map(s=>sum(s,field));return{baselineSamples:before.length,baseline,active:range(active),maximumDelta:baseline!==null&&active.length?Math.max(...active)-baseline:null};};
const rawReceiptHashes={};for(const name of ['receipt.json','network.ndjson','samples.ndjson','resources.ndjson']){try{rawReceiptHashes[name]=hash(await readFile(path.join(directory,name)));}catch(error){if(error.code!=='ENOENT')throw error;}}
let recoveryEvents=[];try{const events=(await readFile(path.join(directory,'network.ndjson'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  recoveryEvents=events.filter(e=>e.event==='finished'&&e.scope==='offscreen'&&!e.status&&e.error&&e.finished-e.started>=14).map(failed=>{
    const next=events.find(e=>e.event==='request'&&e.scope==='page'&&e.urlSha256===failed.urlSha256&&e.range===failed.range&&e.started>=failed.finished);
    const done=next&&events.find(e=>e.event==='finished'&&e.requestId===next.requestId);
    return{urlSha256:failed.urlSha256,range:failed.range,primaryAbortedAt:failed.at,primarySeconds:failed.finished-failed.started,pageRequestedAt:next?.at,pageFinishedAt:done?.at,pageStatus:done?.status,pageBodyBytes:done?.length,pageError:done?.error,scope:'Live CDP abort and subsequent page response; not independent server socket-close proof'};
  });
}catch(error){if(error.code!=='ENOENT')throw error;}
const report={scope:'Independent replacement live acceptance metadata; not original-extension proof',started:receipt.started,ended:receipt.ended,jobId:receipt.finalJob?.id??receipt.latest?.job?.id,
  rawReceiptHashes,recoveryEvents,
  action:receipt.action,actionAt:receipt.actionAt,selectionControl:receipt.selectionControl,observerExit:receipt.observerExit,processingWorkersAfterCleanup:receipt.processingWorkersAfterCleanup,
  artifactBefore:receipt.artifactBefore,artifactAfter:receipt.artifactAfter,artifactUnchanged:receipt.artifactUnchanged,
  source:{pageUrl:receipt.target,masterUrl:master.url,masterSha256:hash(master.text),selectedUrl:selected.url,selectedSha256:hash(selected.text),expectedSegments:expected.length,expectedInitializationObjects:initializations.length},
  transfer:{scope:bothContexts?'Page and offscreen CDP requests; media response body lengths exclude manifests and failed requests. CDP encoded bytes are not a complete wire/TLS measurement.':'Page-context CDP requests only; offscreen-direct successes may be absent. Partial cancellation is not full-source amplification evidence.',totalObservedRequests:receipt.network?.length,mediaRequests:summaries.reduce((n,o)=>n+o.requests,0),requestedRangeSizes:receipt.networkSummary?.rangeSizes,observedMediaObjects:objects.size,observedSegments:expected.filter(u=>objects.has(u)).length,fullyCoveredSegments:expected.filter(u=>objects.get(u)?.fullCoverage).length,knownObjectTotalBytes:sourceBytes,successfulMediaBodyBytes:bodyBytes,successfulEncodedMediaBytes:summaries.reduce((n,o)=>n+o.encodedBytes,0),partialBytesOverKnownObjectSizes:sourceBytes?bodyBytes/sourceBytes:null,fullSourceAmplification:bothContexts&&completeCoverage&&receipt.finalJob?.phase==='complete'?bodyBytes/sourceBytes:null,completeCoverage,maximumObservedActive:receipt.maximumActive,objectCoverageFile:'object-coverage.json alongside raw receipt',objectCoverageSha256:hash(objectCoverageText)},
  progress:{samples:samples.length,firstNonzeroAt:firstProgress?.at??null,lastZeroAt:lastZero?.at??null,lastZeroRequests:lastZero?.requests,zeroSeconds:lastZero?(Date.parse(lastZero.at)-Date.parse(receipt.actionAt))/1000:null,final:receipt.finalJob?.progress??receipt.latest?.job?.progress},
  resources:{scope:'Sampled worker V8 heap/backing store and whole-browser OS process metrics; working-set sums include shared pages, private bytes are process-private committed memory. Baseline is this owned browser with the paused source page before Download, if present.',workerUsed:range(values('usedSize')),workerBacking:range(values('backingStorageSize')),
    processWorkingSetSum:processMeasure('WorkingSet64'),processPrivateBytesSum:processMeasure('PrivateMemorySize64')},
  save:receipt.browserDownload?{id:receipt.browserDownload.id,state:receipt.browserDownload.state,basename:path.basename(receipt.browserDownload.filename),bytes:receipt.browserDownload.bytesReceived,totalBytes:receipt.browserDownload.totalBytes,fileSize:receipt.browserDownload.fileSize}:null,
  phase:receipt.finalJob?.phase??receipt.latest?.job?.phase,cleanup:receipt.cleanup?{entries:receipt.cleanup.entries,hasAttachment:receipt.cleanup.jobs.some(j=>!!j.attachment),hasTempFile:receipt.cleanup.jobs.some(j=>!!j.tempFile)}:null,
  ownedBrowserClosed:receipt.ownedBrowserClosed,errors:receipt.errors};
await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,JSON.stringify(report,null,2));console.log(JSON.stringify({destination,phase:report.phase,transfer:{...report.transfer,objects:undefined},resources:report.resources,progress:report.progress}));
