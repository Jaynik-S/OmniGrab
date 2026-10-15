import { renderSnapshot } from './view.ts';
import type { SnapshotResponse } from './view.ts';

const results = document.querySelector<HTMLElement>('#results')!;
const status = document.querySelector<HTMLElement>('#status')!;
const rescan = document.querySelector<HTMLButtonElement>('#rescan')!;
let tabId: number | undefined;
let requestId = 0;
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
    renderSnapshot(results, response, url => void copy(url));
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
  if (areaName !== 'session' || !changes.detectionState) return;
  if (refreshTimer !== undefined) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { refreshTimer = undefined; void refresh(); }, 80);
});

async function open() {
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active?.id === undefined) throw new Error('No active browser tab');
    tabId = active.id;
    rescan.disabled = false;
    await refresh();
  } catch (error) { status.textContent = explain(error); }
}
void open();
