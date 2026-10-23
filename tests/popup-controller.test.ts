import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import type { TabState } from '../src/core/model.ts';
import type { DownloadJob } from '../src/downloads/model.ts';

const settle = () => new Promise(resolve => setTimeout(resolve, 120));
test('popup subscribes to separate job metadata without a snapshot feedback loop and fences active-tab reads', async () => {
  const document = parseHTML('<html><body><button id="rescan"></button><p id="status"></p><main id="results"></main></body></html>').document;
  let activeId = 7;
  const tabs: Record<number, TabState> = {
    7: { id: 7, epoch: 1, url: 'https://page.test/old', title: 'Old source', documents: { 0: 'doc' }, media: {}, updatedAt: 1, errors: [], dropped: 0 },
    8: { id: 8, epoch: 3, url: 'https://page.test/new', title: 'New active tab', documents: { 0: 'new-doc' }, media: {}, updatedAt: 1, errors: [], dropped: 0 },
  };
  const saved: DownloadJob = { version: 1, id: 'job-a', requestId: 'request-a', createdAt: 1, updatedAt: 2, phase: 'processing',
    selection: { tabId: 7, epoch: 1, mediaId: 'old', instance: 0, pageUrl: tabs[7].url, frameId: 0, documentId: 'doc',
      sourceUrl: 'https://cdn.test/master.m3u8', videoUrl: 'https://cdn.test/720.m3u8', filename: 'Episode.mp4', output: 'mp4' },
    progress: { phase: 'processing', inputBytes: 512, outputBytes: 768 } };
  const calls: any[] = [];
  let changed!: (changes: any, area: string) => void;
  let activated!: () => void;
  let delayed: ((value: unknown) => void) | undefined;
  let delayOld = false;
  let holdJobSnapshot = false;
  let releaseJobSnapshot: ((value: unknown) => void) | undefined;
  const chrome = {
    tabs: { query: async () => [{ id: activeId }], onActivated: { addListener: (fn: () => void) => { activated = fn; } } },
    storage: { onChanged: { addListener: (fn: typeof changed) => { changed = fn; } } },
    runtime: { sendMessage: async (message: any) => {
      calls.push(message);
      if (message.type === 'download-snapshot') {
        if (holdJobSnapshot) return new Promise(resolve => { releaseJobSnapshot = resolve; });
        return { ok: true, jobs: [saved] };
      }
      if (message.type === 'download-cancel') {
        holdJobSnapshot = true;
        changed({ downloadState: { newValue: { version: 1, jobs: [{ ...saved, phase: 'complete' }] } } }, 'local');
        return { ok: true, job: { ...saved, phase: 'canceled' } };
      }
      if (message.type === 'snapshot') {
        if (message.tabId === 7 && delayOld) return new Promise(resolve => { delayed = resolve; });
        return { tab: tabs[message.tabId], revision: 1 };
      }
      throw Error('Unexpected message');
    } },
  };
  const originals = ['document', 'chrome', 'localStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  try {
    Object.defineProperty(globalThis, 'document', { value: document, configurable: true });
    Object.defineProperty(globalThis, 'chrome', { value: chrome, configurable: true });
    Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null, setItem: () => {} }, configurable: true });
    await import('../src/popup/index.ts'); await settle();
    assert.match(document.querySelector('.download-jobs')?.textContent ?? '', /Episode.mp4/);
    assert.equal(calls.filter(m => m.type === 'download-snapshot').length, 1);
    changed({ downloadState: { newValue: { version: 1, jobs: [{ ...saved, phase: 'complete' }] } } }, 'local'); await settle();
    assert.equal(document.querySelector('.job-phase')?.textContent, 'Saved by Chrome');
    assert.equal(calls.filter(m => m.type === 'download-snapshot').length, 1, 'job storage must not cause repeated reconcile writes');
    // A durable storage event can overtake an older command response. Keep the event's newer state.
    changed({ downloadState: { newValue: { version: 1, jobs: [saved] } } }, 'local');
    document.querySelector<HTMLButtonElement>('.download-cancel')!.click(); await settle();
    changed({ detectionState: { newValue: {} } }, 'session'); await settle();
    assert.equal(document.querySelector('.job-phase')?.textContent, 'Saved by Chrome');
    holdJobSnapshot = false; releaseJobSnapshot!({ ok: true, jobs: [{ ...saved, phase: 'complete' }] }); await settle();
    delayOld = true;
    changed({ detectionState: { newValue: {} } }, 'session'); await settle(); assert.ok(delayed);
    activeId = 8; assert.equal(typeof activated, 'function'); activated(); await settle();
    assert.equal(document.querySelector('.context h2')?.textContent, 'New active tab');
    delayed!({ tab: tabs[7], revision: 50 }); await settle();
    assert.equal(document.querySelector('.context h2')?.textContent, 'New active tab', 'old reads must not replace the active tab');
    assert.match(document.querySelector('.download-jobs')!.textContent!, /Earlier \/ other source/);
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
