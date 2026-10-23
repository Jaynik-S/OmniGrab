import { renderSnapshot } from './view.ts';
import type { SnapshotResponse } from './view.ts';
import type { DownloadJob, DownloadStartRequest } from '../downloads/model.ts';
import type { JobOutcome } from '../downloads/coordinator.ts';

const results = document.querySelector<HTMLElement>('#results')!;
const status = document.querySelector<HTMLElement>('#status')!;
const rescan = document.querySelector<HTMLButtonElement>('#rescan')!;
let tabId: number | undefined;
let requestId = 0;
let activationId = 0;
let jobsRevision = 0;
let snapshot: SnapshotResponse = { revision: 0 };
let jobs: DownloadJob[] = [];
let intentStorage: Storage | undefined;
try { intentStorage = globalThis.localStorage; } catch { /* The current popup still retains intent IDs. */ }

function render() {
  renderSnapshot(results, snapshot, url => void copy(url), {
    jobs, intentStorage,
    start: request => control({ type: 'download-start', request }),
    cancel: jobId => control({ type: 'download-cancel', jobId }),
    retry: (jobId, requestId) => control({ type: 'download-retry', jobId, requestId }),
  });
}
async function control(message: { type: 'download-start'; request: DownloadStartRequest } |
    { type: 'download-cancel'; jobId: string } | { type: 'download-retry'; jobId: string; requestId: string }): Promise<JobOutcome> {
  const before = jobsRevision;
  const outcome = await chrome.runtime.sendMessage(message) as JobOutcome;
  if (!outcome || typeof outcome.ok !== 'boolean') throw new Error('Invalid download response');
  if (outcome.job && (jobsRevision === before || !jobs.some(job => job.id === outcome.job!.id))) {
    jobs = [...jobs.filter(job => job.id !== outcome.job!.id), outcome.job];
    jobsRevision++;
  }
  // A command error stays beside its control; reconciliation errors are also shown globally.
  void refreshJobs();
  return outcome;
}
async function refreshJobs() {
  const current = jobsRevision;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'download-snapshot' }) as
      { ok: boolean; jobs: DownloadJob[]; error?: { code: string; message: string } };
    if (!response || !Array.isArray(response.jobs)) throw new Error('Invalid download snapshot');
    if (current === jobsRevision) { jobs = response.jobs; render(); }
    if (response.error) status.textContent = `${response.error.code}: ${response.error.message}`;
  } catch { status.textContent = 'Could not read downloads. Reopen the popup to check the current jobs.'; }
}
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

function explain(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function copy(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    status.textContent = 'URL copied.';
  } catch (error) { status.textContent = `Could not copy URL: ${explain(error)}`; }
}

async function refresh() {
  if (tabId === undefined) return;
  const current = ++requestId;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'snapshot', tabId }) as SnapshotResponse;
    if (current !== requestId) return;
    if (!response || typeof response.revision !== 'number') throw new Error('Invalid snapshot response');
    snapshot = response;
    render();
    if (response.error) status.textContent = response.error;
  } catch (error) { status.textContent = `Could not read detections: ${explain(error)}`; }
}

rescan.addEventListener('click', async () => {
  if (tabId === undefined) return;
  rescan.disabled = true;
  status.textContent = 'Requesting DOM and resource rescan…';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'rescan', tabId }) as { error?: string } | undefined;
    if (response?.error) throw new Error(response.error);
    status.textContent = 'Rescan requested. New observations appear as they arrive.';
    await refresh();
  } catch (error) { status.textContent = `Rescan unavailable: ${explain(error)}`; }
  finally { rescan.disabled = false; }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.downloadState) {
    const value = changes.downloadState.newValue as { version?: number; jobs?: DownloadJob[] } | undefined;
    if (value?.version === 1 && Array.isArray(value.jobs)) {
      jobsRevision++;
      jobs = value.jobs;
      render();
    } else status.textContent = 'Download metadata is unavailable. Reopen the popup to check recovery.';
    return;
  }
  if (areaName !== 'session' || !changes.detectionState) return;
  if (refreshTimer !== undefined) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { refreshTimer = undefined; void refresh(); }, 80);
});

async function open() {
  const current = ++activationId;
  ++requestId;
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (current !== activationId) return;
    if (active?.id === undefined) throw new Error('No active browser tab');
    tabId = active.id;
    snapshot = { revision: 0 };
    render();
    rescan.disabled = false;
    await Promise.all([refresh(), refreshJobs()]);
  } catch (error) { status.textContent = explain(error); }
}
chrome.tabs.onActivated.addListener(() => { void open(); });
void open();
