import test from 'node:test';
import assert from 'node:assert/strict';
import { checkStorageBudget, safeStorageCode } from '../src/downloads/storage.ts';

test('storage preflight reserves two media copies with margin and rejects insufficient quota', async () => {
  await assert.rejects(checkStorageBudget(40000000, async () => ({ quota: 116777215, usage: 0 })), /download-storage-insufficient/);
  await checkStorageBudget(40000000, async () => ({ quota: 116777217, usage: 1 }));
  await assert.rejects(checkStorageBudget(40000000, async () => ({ quota: 200000000, usage: 100000000 })), /download-storage-insufficient/);
});

test('unknown media or unavailable approximate quota never becomes a false capacity promise', async () => {
  for (const size of [undefined, 0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER])
    await assert.rejects(checkStorageBudget(size, async () => ({ quota: 100000000, usage: 0 })), /download-storage-budget-unknown/);
  for (const estimate of [{}, {quota: Infinity, usage: 0}, {quota: 10}, {quota: 10, usage: -1}, {quota: 10, usage: NaN}, {quota: 1e30, usage: 0}])
    await assert.rejects(checkStorageBudget(1, async () => estimate), /download-storage-estimate-unavailable/);
  await assert.rejects(checkStorageBudget(1, async () => { throw Error('secret URL'); }), { message: 'download-storage-estimate-unavailable' });
});

test('only fixed storage reasons cross worker and host boundaries', () => {
  for (const code of ['download-storage-insufficient','download-storage-budget-unknown','download-storage-estimate-unavailable','download-storage-quota-exceeded','download-storage-write-failed']) assert.equal(safeStorageCode(code), code);
  assert.equal(safeStorageCode('https://private.test/?token=secret'), undefined);
  assert.equal(safeStorageCode({message:'download-storage-write-failed'}), undefined);
});
