import type { Snapshot } from '../core/model.ts';
import { emptySnapshot, MAX_ITEMS } from '../core/reducer.ts';

export interface SnapshotPersistence {
  load: () => Promise<Snapshot | undefined>;
  save: (snapshot: Snapshot) => Promise<void>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 16_384;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const natural = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value) && value >= 0;
const optional = (value: unknown, validate: (value: unknown) => boolean) => value === undefined || validate(value);
const list = (value: unknown, limit: number, validate: (value: unknown) => boolean) =>
  Array.isArray(value) && value.length <= limit && value.every(validate);
const numericKey = (key: string) => /^(?:0|[1-9]\d*)$/.test(key) && natural(Number(key));

function validVariant(value: unknown): boolean {
  if (!record(value) || !text(value.id)) return false;
  for (const name of ['url', 'codecs', 'language', 'group', 'audioGroup', 'subtitleGroup', 'representationId']) {
    if (!optional(value[name], text)) return false;
  }
  for (const name of ['bandwidth', 'width', 'height']) if (!optional(value[name], finite)) return false;
  return optional(value.kind, kind => kind === 'video' || kind === 'audio' || kind === 'subtitles');
}

function validMedia(value: unknown, key: string): boolean {
  if (!record(value) || value.id !== key || value.url !== key || !text(value.url)) return false;
  if (!['direct', 'hls', 'dash', 'blob', 'unknown'].includes(String(value.type)) ||
      !['observed', 'probing', 'confirmed', 'unresolved', 'unsupported'].includes(String(value.status))) return false;
  if (!finite(value.firstSeen) || !finite(value.lastSeen) || !optional(value.instance, natural)) return false;
  if (!list(value.methods, 100, method => ['network', 'dom', 'resource', 'manifest', 'adapter'].includes(String(method))) ||
      !list(value.frameIds, 100, natural) || !list(value.documentIds, 100, text) || !list(value.elementIds, 100, text) ||
      !list(value.variants, 20, validVariant) || !list(value.childUrls, 10_000, text) || !list(value.segmentUrls, 10_000, text)) return false;
  for (const name of ['mime', 'title', 'poster', 'reason']) if (!optional(value[name], text)) return false;
  for (const name of ['bytes', 'width', 'height', 'duration']) if (!optional(value[name], finite)) return false;
  return optional(value.protected, flag => typeof flag === 'boolean') && optional(value.live, flag => typeof flag === 'boolean');
}

/** Reject corrupted or future snapshots rather than letting malformed nested data reach reducers. */
function validSnapshot(value: unknown): value is Snapshot {
  if (!record(value) || value.version !== 1 || !natural(value.revision) || !record(value.tabs)) return false;
  if (Object.keys(value.tabs).length > 50) return false;
  return Object.entries(value.tabs).every(([key, tab]) => {
    if (!numericKey(key) || !record(tab) || tab.id !== Number(key) || !text(tab.url) || !natural(tab.epoch) ||
        !finite(tab.updatedAt) || !natural(tab.dropped) || !optional(tab.title, text) || !optional(tab.documentId, text) ||
        !record(tab.documents) || Object.keys(tab.documents).length > 100 || !record(tab.media) ||
        Object.keys(tab.media).length > MAX_ITEMS || !list(tab.errors, 100, text)) return false;
    return Object.entries(tab.documents).every(([frame, id]) => numericKey(frame) && text(id)) &&
      Object.entries(tab.media).every(([id, item]) => validMedia(item, id));
  });
}

/** One ordered restore/mutation chain; a saved snapshot is the only committed snapshot. */
export class DetectionStore {
  error?: string;
  private state = emptySnapshot();
  private tail: Promise<void>;
  private persistence: SnapshotPersistence;

  constructor(persistence: SnapshotPersistence) {
    this.persistence = persistence;
    this.tail = this.restore();
  }

  private async restore(): Promise<void> {
    try {
      const snapshot = await this.persistence.load();
      if (snapshot === undefined) return;
      if (!validSnapshot(snapshot)) throw new Error('Invalid detection snapshot');
      this.state = structuredClone(snapshot);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  async read(): Promise<Snapshot> {
    await this.tail;
    return structuredClone(this.state);
  }

  dispatch(transition: (snapshot: Snapshot) => Snapshot): Promise<Snapshot> {
    const result = this.tail.then(async () => {
      const input = structuredClone(this.state);
      const next = transition(input);
      if (next === input) return structuredClone(this.state);
      const committed = structuredClone(next);
      try {
        await this.persistence.save(structuredClone(committed));
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
      this.state = committed;
      this.error = undefined;
      return structuredClone(committed);
    });
    // The caller sees its rejection; subsequent events still have a usable queue.
    this.tail = result.then(() => {}, () => {});
    return result;
  }
}
