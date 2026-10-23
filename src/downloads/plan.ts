import { readManifestBody, MAX_MANIFEST_BYTES } from '../manifests/response.ts';
import { parseDownloadHls } from './hls-plan.ts';
import { httpUrl, validSelection } from './validation.ts';
import type { DownloadPlan, DownloadSelection, ResourceFetch } from './model.ts';

/** Resolve just the requested video and declared companion audio under explicit grants. */
export async function resolveDownloadPlan(selection: DownloadSelection, fetcher: ResourceFetch, signal: AbortSignal): Promise<DownloadPlan> {
  if (!validSelection(selection)) throw new Error('Invalid download selection');
  signal.throwIfAborted();
  const plan: DownloadPlan = { selection: structuredClone(selection), manifests: [], resources: [] };
  const loaded = new Map<string, { playlist: ReturnType<typeof parseDownloadHls>; finalUrl: string }>();
  const load = async (url: string) => {
    signal.throwIfAborted();
    const cached = loaded.get(url);
    if (cached) return cached;
    let response: Response;
    try { response = await fetcher(url, { signal, credentials: 'include', redirect: 'follow' }); }
    catch { signal.throwIfAborted(); throw new Error('Download manifest fetch failed'); }
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error('Download manifest response failed'); }
    const finalUrl = response.url || url;
    if (!httpUrl(finalUrl)) { void response.body?.cancel().catch(() => {}); throw new Error('Unsafe download manifest redirect'); }
    let text: string;
    try { text = await readManifestBody(response, MAX_MANIFEST_BYTES, signal); }
    catch { signal.throwIfAborted(); throw new Error('Download manifest body limit or encoding failure'); }
    let playlist: ReturnType<typeof parseDownloadHls>;
    try { playlist = parseDownloadHls(text, url, finalUrl); }
    catch (error) {
      // Parser messages are fixed diagnostics; never surface input or transport URL values.
      if (error instanceof Error && /^(?:Unsupported|Protected|A complete)/.test(error.message)) throw error;
      throw new Error('Unsupported or malformed HLS download manifest');
    }
    const result = { playlist, finalUrl };
    loaded.set(url, result); loaded.set(finalUrl, result);
    for (const alias of new Set([url, finalUrl])) plan.manifests.push({ url: alias, text: playlist.text });
    return result;
  };
  const source = await load(selection.sourceUrl);
  let videoUrl = source.finalUrl;
  let audioUrl: string | undefined;
  if (source.playlist.master) {
    const explicit = selection.requestedVariantId !== undefined;
    const video = explicit ? source.playlist.videos.find(v => v.originalUrl === selection.videoUrl || v.url === selection.videoUrl) :
      [...source.playlist.videos].sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || b.bandwidth - a.bandwidth)[0];
    if (!video || explicit && (selection.width !== undefined && video.width !== selection.width || selection.height !== undefined && video.height !== selection.height))
      throw new Error('Selected video rendition is unavailable');
    delete plan.selection.width; delete plan.selection.height;
    if (video.width !== undefined) plan.selection.width = video.width;
    if (video.height !== undefined) plan.selection.height = video.height;
    videoUrl = video.url;
    if (video.audioGroup) {
      const audio = source.playlist.audio.filter(a => a.group === video.audioGroup);
      const defaults = audio.filter(a => a.default);
      const chosen = defaults.length === 1 ? defaults[0] : audio.length === 1 ? audio[0] : undefined;
      if (!chosen) throw new Error('Declared audio rendition is missing or ambiguous');
      audioUrl = chosen.url;
    }
  } else if (selection.videoUrl !== selection.sourceUrl || selection.audioUrl) throw new Error('Selected video rendition is unavailable');
  const video = source.playlist.master ? await load(videoUrl) : source;
  if (video.playlist.master) throw new Error('Unsupported nested video master');
  plan.selection.videoUrl = video.finalUrl;
  delete plan.selection.audioUrl;
  plan.duration = video.playlist.duration;
  plan.resources.push(...video.playlist.resources);
  if (audioUrl) {
    const audio = await load(audioUrl);
    if (audio.playlist.master) throw new Error('Unsupported nested audio master');
    plan.selection.audioUrl = audio.finalUrl;
    plan.resources.push(...audio.playlist.resources);
  }
  const grants = new Set<string>();
  plan.resources = plan.resources.filter(grant => {
    const key = JSON.stringify([grant.url, grant.range?.start ?? null, grant.range?.end ?? null]);
    if (grants.has(key)) return false;
    grants.add(key); return true;
  });
  signal.throwIfAborted();
  return plan;
}
