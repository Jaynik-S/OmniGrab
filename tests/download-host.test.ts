import test from 'node:test';
import assert from 'node:assert/strict';
import { createOffscreenManager } from '../src/downloads/browser-adapter.ts';
test('concurrent host creation shares one Chrome-120 getContexts/createDocument operation',async()=>{
 let creates=0, exists=false;const manager=createOffscreenManager({contexts:async()=>exists,create:async()=>{creates++;await new Promise(r=>setTimeout(r,5));exists=true;}});
 await Promise.all([manager.ensure(),manager.ensure(),manager.ensure()]);assert.equal(creates,1);await manager.ensure();assert.equal(creates,1);
});
test('host creation failure resets gate for a later retry',async()=>{
 let creates=0;const manager=createOffscreenManager({contexts:async()=>false,create:async()=>{if(++creates===1)throw Error('no');}});
 await assert.rejects(manager.ensure());await manager.ensure();assert.equal(creates,2);
});
