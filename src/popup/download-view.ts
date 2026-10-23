import type { MediaItem, TabState } from '../core/model.ts';
import type { DownloadJob, DownloadStartRequest } from '../downloads/model.ts';
import type { JobOutcome } from '../downloads/coordinator.ts';
import { httpUrl, safeFilename } from '../downloads/validation.ts';

export interface DownloadViewOptions {
  jobs: DownloadJob[];
  start(request: DownloadStartRequest): Promise<JobOutcome>;
  cancel?(jobId: string): Promise<JobOutcome>;
  retry?(jobId: string, requestId: string): Promise<JobOutcome>;
  /** Small, bounded intent metadata survives a popup closing during a lost RPC response. */
  intentStorage?: Pick<Storage, 'getItem' | 'setItem'>;
}
interface FormState { filename: string; variantId?: string; }
interface Intent { key: string; id: string; }
interface ViewState {
  forms: Map<string, FormState>; intents: Intent[]; pending: Set<string>;
  accepted: Set<string>; errors: Map<string, string>; redraw(): void;
}
const states = new WeakMap<HTMLElement, ViewState>();
const intentKey = 'popupDownloadIntents-v1';
const active = new Set(['queued', 'resolving', 'processing', 'ready-to-save', 'saving']);

function element(document: Document, tag: string, text?: string, className?: string): HTMLElement {
  const value = document.createElement(tag);
  if (text !== undefined) value.textContent = text;
  if (className) value.className = className;
  return value;
}
function sourceKey(tab: TabState, item: MediaItem): string {
  return JSON.stringify([tab.id, tab.epoch, item.id, item.instance ?? 0]);
}
function unavailable(item: MediaItem, tab: TabState): string | undefined {
  if (item.type === 'blob' || !httpUrl(item.url)) return 'A local blob is not a downloadable remote source.';
  if (item.type !== 'hls') return 'MP4 output currently supports HLS sources only.';
  if (item.status !== 'confirmed') return 'Confirm the HLS source before downloading.';
  if (item.protected === true) return 'Protected media is not supported.';
  if (item.protected !== false) return 'Source protection has not been checked yet.';
  if (item.live === true) return 'Live HLS is not supported; a complete VOD source is required.';
  if (!item.frameIds.some(frame => item.documentIds.includes(tab.documents[frame]))) return 'The source document is no longer available. Rescan the page.';
  if (item.variants.length && !item.variants.some(v => v.kind === 'video' && httpUrl(v.url))) return 'No supported video rendition was confirmed.';
}
function getState(target: HTMLElement, options: DownloadViewOptions, redraw: () => void): ViewState {
  let state = states.get(target);
  if (!state) {
    let intents: Intent[] = [];
    try {
      const stored: unknown = JSON.parse(options.intentStorage?.getItem(intentKey) ?? '[]');
      if (Array.isArray(stored)) intents = stored.filter((v): v is Intent => v && typeof v.key === 'string' && v.key.length <= 40_000 && typeof v.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v.id)).slice(-50);
    } catch { /* Unavailable browser UI storage falls back to the current popup lifetime. */ }
    state = { forms: new Map(), intents, pending: new Set(), accepted: new Set(), errors: new Map(), redraw };
    states.set(target, state);
  }
  state.redraw = redraw;
  return state;
}
function requestId(state: ViewState, key: string, options: DownloadViewOptions): string {
  const previous = state.intents.find(intent => intent.key === key);
  if (previous) return previous.id;
  const id = crypto.randomUUID();
  state.intents = [...state.intents, { key, id }].slice(-50);
  try { options.intentStorage?.setItem(intentKey, JSON.stringify(state.intents)); } catch { /* Memory still protects double clicks. */ }
  return id;
}
async function perform(state: ViewState, key: string, action: () => Promise<JobOutcome>): Promise<void> {
  if (state.pending.has(key)) return;
  state.pending.add(key); state.errors.delete(key); state.redraw();
  try {
    const outcome = await action();
    if (outcome.ok) state.accepted.add(key);
    else state.errors.set(key, `${outcome.error.code}: ${outcome.error.message}`);
  } catch {
    state.errors.set(key, 'The response was lost. Try the same action again to check its result safely.');
  } finally { state.pending.delete(key); state.redraw(); }
}
function feedback(document: Document, state: ViewState, key: string): HTMLElement {
  const message = element(document, 'p', state.errors.get(key), 'error');
  message.setAttribute('role', 'status');
  return message;
}

export function downloadView(target: HTMLElement, options: DownloadViewOptions, redraw: () => void) {
  const document = target.ownerDocument;
  const state = getState(target, options, redraw);
  return {
    source(item: MediaItem, tab: TabState): HTMLElement {
      const section = element(document, 'section', undefined, 'download-controls');
      section.append(element(document, 'p', 'Output: MP4 · Original video and audio', 'output'));
      const reason = unavailable(item, tab);
      if (reason) { section.append(element(document, 'p', reason, 'download-unavailable muted')); return section; }
      const key = sourceKey(tab, item);
      const variants = item.variants.filter(v => v.kind === 'video' && httpUrl(v.url))
        .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
      const form = state.forms.get(key) ?? { filename: safeFilename(item.title || tab.title || 'video'), variantId: variants[0]?.id };
      state.forms.set(key, form);
      const selectedUnavailable = () => form.variantId !== undefined && !variants.some(v => v.id === form.variantId);
      const filenameLabel = element(document, 'label', 'Filename');
      const filename = element(document, 'input') as HTMLInputElement;
      filename.type = 'text'; filename.maxLength = 255; filename.value = form.filename;
      filename.dataset.control = key + ':filename'; filename.setAttribute('aria-label', 'MP4 filename');
      filename.addEventListener('input', () => { form.filename = filename.value; updateButton(); });
      filenameLabel.append(filename); section.append(filenameLabel);
      const qualityLabel = element(document, 'label', 'Quality');
      const quality = element(document, 'select') as HTMLSelectElement;
      quality.dataset.control = key + ':quality'; quality.setAttribute('aria-label', 'Video quality');
      if (selectedUnavailable()) {
        const unavailable = element(document, 'option', 'Selected quality (unavailable)') as HTMLOptionElement;
        unavailable.value = form.variantId!; unavailable.selected = true; quality.append(unavailable);
      } else if (!variants.length) quality.append(element(document, 'option', 'Source quality'));
      for (const variant of variants) {
        const option = element(document, 'option', variant.height ? `${variant.height}p` : variant.bandwidth ? `${variant.bandwidth.toLocaleString()} bit/s` : 'Source quality') as HTMLOptionElement;
        option.value = variant.id; option.selected = variant.id === form.variantId; quality.append(option);
      }
      quality.disabled = !variants.length && !selectedUnavailable();
      quality.addEventListener('change', () => { form.variantId = quality.value || undefined; updateButton(); });
      qualityLabel.append(quality); section.append(qualityLabel);
      const selectionMessage = element(document, 'p', undefined, 'download-unavailable muted');
      section.append(selectionMessage);
      const button = element(document, 'button', 'Download MP4', 'download-start') as HTMLButtonElement;
      button.type = 'button'; button.dataset.control = key + ':download';
      const intent = () => JSON.stringify(['start', key, form.variantId, form.filename]);
      function updateButton() {
        const current = intent();
        const known = state.intents.find(i => i.key === current);
        const accepted = state.accepted.has(current) || !!known && options.jobs.some(job => job.requestId === known.id);
        button.disabled = state.pending.has(current) || accepted || !form.filename.trim() || selectedUnavailable();
        selectionMessage.textContent = selectedUnavailable() ? 'Selected quality is no longer confirmed. Choose an available rendition.' : '';
        button.textContent = state.pending.has(current) ? 'Starting…' : accepted ? 'Download started' : 'Download MP4';
      }
      updateButton();
      button.addEventListener('click', () => {
        if (button.disabled) return;
        const current = intent();
        const request: DownloadStartRequest = { requestId: requestId(state, current, options), tabId: tab.id, epoch: tab.epoch,
          mediaId: item.id, instance: item.instance ?? 0, filename: form.filename, ...(form.variantId ? { variantId: form.variantId } : {}) };
        void perform(state, current, () => options.start(request));
      });
      section.append(button, feedback(document, state, intent()));
      return section;
    },
    jobs(tab?: TabState): HTMLElement {
      const section = element(document, 'section', undefined, 'download-jobs');
      section.setAttribute('aria-label', 'Downloads'); section.append(element(document, 'h2', 'Downloads'));
      // A history record always owns its immutable selection, including after navigation or tab changes.
      const jobs = [...options.jobs].sort((a, b) => b.createdAt - a.createdAt);
      if (!jobs.length) section.append(element(document, 'p', 'No downloads yet.', 'muted'));
      for (const job of jobs) {
        const article = element(document, 'article', undefined, 'download-job'); article.dataset.jobId = job.id;
        const sameSource = tab?.id === job.selection.tabId && tab.epoch === job.selection.epoch &&
          (tab.media[job.selection.mediaId]?.instance ?? 0) === job.selection.instance && !!tab.media[job.selection.mediaId];
        article.append(element(document, 'h3', job.selection.filename));
        article.append(element(document, 'p', `${sameSource ? 'Current source' : 'Earlier / other source'} · Tab ${job.selection.tabId} · HLS to MP4${job.selection.height ? ` · ${job.selection.height}p` : ''}`, 'muted'));
        const phase = job.phase === 'processing' && job.progress.phase === 'finalizing' ? 'Finalizing MP4' : {
          queued: 'Queued', resolving: 'Resolving HLS', processing: 'Processing media', 'ready-to-save': 'Preparing browser save',
          saving: 'Saving in Chrome', complete: 'Saved by Chrome', canceled: 'Canceled', interrupted: 'Interrupted', failed: 'Failed',
        }[job.phase];
        article.append(element(document, 'p', phase, 'job-phase'));
        const p = job.progress;
        article.append(element(document, 'p', `Media read: ${p.inputBytes.toLocaleString()} bytes · MP4 written: ${p.outputBytes.toLocaleString()} bytes · Total size unknown`, 'muted'));
        if (p.seconds !== undefined && p.duration !== undefined && p.duration > 0) {
          const progress = element(document, 'progress') as HTMLProgressElement;
          progress.max = p.duration; progress.value = Math.min(p.seconds, p.duration); progress.setAttribute('aria-label', 'Media time processed');
          article.append(progress);
        }
        if (job.failure) article.append(element(document, 'p', `${job.failure.code}: ${job.failure.message}`, 'error'));
        if (job.phase === 'complete') article.append(element(document, 'p', 'Chrome completed the file save.', 'muted'));
        const blocked = ['download-save-uncertain', 'download-cleanup-pending'].includes(job.failure?.code ?? '');
        const cancel = active.has(job.phase) && options.cancel;
        const retry = !active.has(job.phase) && job.phase !== 'complete' && options.retry;
        if (cancel || retry) {
          const key = JSON.stringify([cancel ? 'cancel' : 'retry', job.id]);
          const button = element(document, 'button', cancel ? 'Cancel' : 'Retry') as HTMLButtonElement;
          button.type = 'button'; button.className = cancel ? 'download-cancel' : 'download-retry'; button.dataset.control = key;
          button.disabled = blocked || state.pending.has(key) || state.accepted.has(key);
          button.addEventListener('click', () => {
            if (button.disabled) return;
            void perform(state, key, () => cancel ? options.cancel!(job.id) : options.retry!(job.id, requestId(state, key, options)));
          });
          article.append(button, feedback(document, state, key));
        }
        section.append(article);
      }
      return section;
    },
  };
}
