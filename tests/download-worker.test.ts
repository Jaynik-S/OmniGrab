import test from 'node:test';
import assert from 'node:assert/strict';
import { watchWorker } from '../src/downloads/worker-watchdog.ts';
test('a silently terminated dedicated worker loses its lease after missing heartbeats',async()=>{
 let lost=0;const monitor=watchWorker(()=>lost++,25);await new Promise(r=>setTimeout(r,45));assert.equal(lost,1);monitor.dispose();
});
test('worker heartbeats renew its lease and disposal prevents a spurious failure',async()=>{
 let lost=0;const monitor=watchWorker(()=>lost++,60);await new Promise(r=>setTimeout(r,20));monitor.beat();await new Promise(r=>setTimeout(r,20));assert.equal(lost,0);monitor.dispose();await new Promise(r=>setTimeout(r,70));assert.equal(lost,0);
});
