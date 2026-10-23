import type { DownloadJob, DownloadPhase, DownloadState } from './model.ts';
import { natural, onlyKeys, record, text, validSelection } from './validation.ts';

export interface DownloadPersistence {
  load(): Promise<unknown>;
  save(state: DownloadState): Promise<void>;
}
export const MAX_QUEUED_DOWNLOADS = 2;
export const MAX_TERMINAL_DOWNLOADS = 50;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const phases: DownloadPhase[] = ['queued', 'resolving', 'processing', 'ready-to-save', 'saving', 'complete', 'failed', 'canceled', 'interrupted'];
const terminals: DownloadPhase[] = ['complete', 'failed', 'canceled', 'interrupted'];
export const isTerminalPhase = (phase: DownloadPhase): boolean => terminals.includes(phase);
const optional = (value: unknown, valid: (value: unknown) => boolean) => value === undefined || valid(value);
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const id = (value: unknown) => text(value, 128);

function validJob(value: unknown): value is DownloadJob {
  if (!record(value) || !onlyKeys(value, ['version', 'id', 'requestId', 'selection', 'phase', 'createdAt', 'updatedAt', 'progress',
    'tempFile', 'browserDownloadId', 'failure', 'attachment', 'saveIntent']) || value.version !== 1 || !id(value.id) || !id(value.requestId) ||
    !validSelection(value.selection) || !phases.includes(value.phase as DownloadPhase) ||
    !natural(value.createdAt) || !natural(value.updatedAt) || value.updatedAt < value.createdAt || !record(value.progress) ||
    !onlyKeys(value.progress, ['phase', 'inputBytes', 'outputBytes', 'seconds', 'duration']) ||
    !['processing', 'finalizing'].includes(String(value.progress.phase)) || !natural(value.progress.inputBytes) || !natural(value.progress.outputBytes) ||
    !optional(value.progress.seconds, nonnegative) || !optional(value.progress.duration, nonnegative) ||
    !optional(value.tempFile, file => text(file, 200) && /^[a-z0-9][a-z0-9._-]*$/i.test(file) && !file.includes('..')) ||
    !optional(value.browserDownloadId, natural)) return false;
  const selection = value.selection, createdAt = value.createdAt, updatedAt = value.updatedAt;
  if (value.phase === 'queued' && value.attachment !== undefined ||
    !['ready-to-save', 'saving', ...terminals].includes(String(value.phase)) && value.saveIntent !== undefined) return false;
  if (!optional(value.attachment, a => record(a) && onlyKeys(a, ['jobId', 'capability', 'tabId', 'frameId', 'documentId']) &&
    a.jobId === value.id && typeof a.capability === 'string' && /^[a-zA-Z0-9_-]{32,128}$/.test(a.capability) &&
    a.tabId === selection.tabId && a.frameId === selection.frameId && a.documentId === selection.documentId)) return false;
  if (!optional(value.saveIntent, s => record(s) && onlyKeys(s, ['objectUrl', 'attemptedAt']) &&
    typeof s.objectUrl === 'string' && /^blob:chrome-extension:\/\/[a-p]{32}\/[a-zA-Z0-9_-]{1,128}$/.test(s.objectUrl) &&
    natural(s.attemptedAt) && s.attemptedAt >= createdAt && s.attemptedAt <= updatedAt)) return false;
  return optional(value.failure, failure => record(failure) && onlyKeys(failure, ['code', 'message']) &&
    text(failure.code, 64) && /^[a-z0-9_-]+$/i.test(failure.code) && text(failure.message, 512) && !/\b(?:https?|blob|file):/i.test(failure.message));
}

function validateState(value: unknown, restoring: boolean): DownloadState {
  if (!record(value) || !onlyKeys(value, ['version', 'jobs']) || value.version !== 1 || !Array.isArray(value.jobs) ||
      value.jobs.length > MAX_TERMINAL_DOWNLOADS + MAX_QUEUED_DOWNLOADS + (restoring ? 1 : 2) || !value.jobs.every(validJob))
    throw new Error('Invalid download metadata');
  const jobs: DownloadJob[] = value.jobs;
  const ids = new Set<string>(); const requests = new Set<string>(); const selections = new Set<string>(); const intents = new Set<string>();
  let active = 0; let queued = 0;
  for (const job of jobs) {
    if (ids.has(job.id) || requests.has(job.requestId)) throw new Error('Duplicate download identity');
    ids.add(job.id); requests.add(job.requestId);
    if (job.saveIntent) {
      if (intents.has(job.saveIntent.objectUrl)) throw new Error('Duplicate browser save intent');
      intents.add(job.saveIntent.objectUrl);
    }
    if (isTerminalPhase(job.phase)) continue;
    if (job.phase === 'queued') queued++; else active++;
    const key = JSON.stringify([job.selection.sourceUrl, job.selection.videoUrl, job.selection.audioUrl ?? null]);
    if (selections.has(key)) throw new Error('Duplicate download source selection');
    selections.add(key);
  }
  if (active > 1) throw new Error('Active download limit exceeded');
  if (queued > MAX_QUEUED_DOWNLOADS) throw new Error('Download queue limit exceeded');
  const terminal = jobs.filter(job => isTerminalPhase(job.phase));
  if (restoring && terminal.length > MAX_TERMINAL_DOWNLOADS) throw new Error('Invalid download retention limit');
  const retain = new Set(terminal.map((job, order) => ({ job, order }))
    .sort((a, b) => b.job.updatedAt - a.job.updatedAt || b.order - a.order)
    .slice(0, MAX_TERMINAL_DOWNLOADS).map(entry => entry.job.id));
  const result: DownloadState = { version: 1, jobs: jobs.filter(job => !isTerminalPhase(job.phase) || retain.has(job.id)) };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_METADATA_BYTES) throw new Error('Download metadata size limit exceeded');
  return result;
}

/** One ordered restore/mutation chain; acknowledgment follows durable save. */
export class DownloadStore {
  error?: string;
  private state: DownloadState = { version: 1, jobs: [] };
  private tail: Promise<void>;
  private persistence: DownloadPersistence;

  constructor(persistence: DownloadPersistence) {
    this.persistence = persistence;
    this.tail = this.restore();
  }

  private async restore(): Promise<void> {
    try {
      const value = await this.persistence.load();
      if (value !== undefined) this.state = structuredClone(validateState(value, true));
    } catch {
      this.error = 'Invalid or unavailable download metadata restore';
    }
  }

  async read(): Promise<DownloadState> {
    await this.tail;
    return structuredClone(this.state);
  }

  dispatch(transition: (state: DownloadState) => DownloadState): Promise<DownloadState> {
    const result = this.tail.then(async () => {
      const next = structuredClone(validateState(transition(structuredClone(this.state)), false));
      try { await this.persistence.save(structuredClone(next)); }
      catch {
        this.error = 'Download metadata save failed';
        throw new Error(this.error);
      }
      this.state = next;
      this.error = undefined;
      return structuredClone(next);
    });
    this.tail = result.then(() => {}, () => {});
    return result;
  }
}
