import type { InputAudioTrack, InputVideoTrack } from 'mediabunny';
import type { DownloadPlan, ResourceGrant } from './model.ts';
import { parseDownloadHls } from './hls-plan.ts';
import type { RemuxSourceAdapter } from './remux-source.ts';

function signature(value: unknown): string {
  if (value instanceof ArrayBuffer) return [...new Uint8Array(value)].join(',');
  if (ArrayBuffer.isView(value)) return [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)].join(',');
  if (value && typeof value === 'object') return Object.keys(value).sort().map(key => `${key}:${signature((value as Record<string, unknown>)[key])}`).join('|');
  return JSON.stringify(value);
}

interface SegmentDescriptor extends ResourceGrant {
  playlistUrl: string; map?: ResourceGrant; text: string; video: boolean; audio: boolean;
}

/** Keep current MAP and resolved inclusive byte ranges; timing remains owned by the original Input. */
function* segments(plan: DownloadPlan): Generator<SegmentDescriptor> {
  const separateAudio = plan.selection.audioUrl !== plan.selection.videoUrl ? plan.selection.audioUrl : undefined;
  const playlists = [{ url: plan.selection.videoUrl, video: true, audio: !separateAudio },
    ...(separateAudio ? [{ url: separateAudio, video: false, audio: true }] : [])];
  for (const playlist of playlists) {
    const manifest = plan.manifests.find(entry => entry.url === playlist.url);
    if (!manifest) throw new Error('Selected playlist is missing');
    const parsed = parseDownloadHls(manifest.text, playlist.url, playlist.url);
    if (parsed.master) throw new Error('Selected playlist must contain media');
    let map = ''; let mapGrant: ResourceGrant | undefined; let duration = ''; let resource = 0;
    for (const raw of parsed.text.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('#EXT-X-MAP:')) { map = line; mapGrant = parsed.resources[resource++]; }
      else if (line.startsWith('#EXTINF:')) duration = line;
      else if (line && !line.startsWith('#')) {
        const grant = parsed.resources[resource++]!;
        const range = grant.range ? `#EXT-X-BYTERANGE:${grant.range.end - grant.range.start + 1}@${grant.range.start}` : '';
        const target = Math.max(1, Math.ceil(Number.parseFloat(duration.slice('#EXTINF:'.length))));
        yield { ...grant, playlistUrl: playlist.url, map: mapGrant, video: playlist.video, audio: playlist.audio,
          text: ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${target}`, map, duration, range, line, '#EXT-X-ENDLIST'].filter(Boolean).join('\n') };
      }
    }
  }
}

async function segmentValidator(sources: RemuxSourceAdapter, video: InputVideoTrack, audio: InputAudioTrack) {
  const expectedVideo = signature({ codec: await video.getCodec(), width: await video.getCodedWidth(),
    height: await video.getCodedHeight(), config: await video.getDecoderConfig() });
  const expectedAudio = signature({ codec: await audio.getCodec(), config: await audio.getDecoderConfig() });
  return async (segment: SegmentDescriptor): Promise<void> => {
    sources.check();
    const probe = sources.open(segment.playlistUrl, segment.text);
    try {
      if (segment.video) {
        const actual = await probe.getPrimaryVideoTrack();
        if (!actual || signature({ codec: await actual.getCodec(), width: await actual.getCodedWidth(),
          height: await actual.getCodedHeight(), config: await actual.getDecoderConfig() }) !== expectedVideo)
          throw new Error('Video decoder configuration or dimensions change between HLS segments');
      }
      if (segment.audio) {
        const actual = await probe.getPrimaryAudioTrack();
        if (!actual || signature({ codec: await actual.getCodec(), config: await actual.getDecoderConfig() }) !== expectedAudio)
          throw new Error('Audio decoder configuration changes between HLS segments');
      }
      sources.check();
    } finally { sources.release(probe); }
  };
}

/** Public segmented getters only expose the first track. Probe each segment's actual track separately. */
export async function validateSegmentConfigurations(plan: DownloadPlan, sources: RemuxSourceAdapter,
  video: InputVideoTrack, audio: InputAudioTrack): Promise<void> {
  const validate = await segmentValidator(sources, video, audio);
  for (const segment of segments(plan)) await validate(segment);
}

/** Gate unambiguous child URLs; a URL-only source callback cannot distinguish reused ranges or MAP identities. */
export async function prepareSegmentValidation(plan: DownloadPlan, sources: RemuxSourceAdapter,
  video: InputVideoTrack, audio: InputAudioTrack): Promise<void> {
  const descriptors = [...segments(plan)];
  const byUrl = new Map(descriptors.map(segment => [segment.url, segment]));
  const maps = new Map<string, string>();
  let ambiguous = byUrl.size !== descriptors.length;
  for (const segment of descriptors) {
    if (plan.manifests.some(manifest => manifest.url === segment.url)) ambiguous = true;
    if (segment.map) {
      const identity = signature(segment.map);
      if (byUrl.has(segment.map.url) || maps.has(segment.map.url) && maps.get(segment.map.url) !== identity) ambiguous = true;
      maps.set(segment.map.url, identity);
    }
  }
  if (ambiguous) return validateSegmentConfigurations(plan, sources, video, audio);
  const validate = await segmentValidator(sources, video, audio);
  const validation = new Map<string, Promise<void>>();
  const gate = (url: string): Promise<void> => {
    const segment = byUrl.get(url);
    if (!segment) return Promise.resolve();
    let pending = validation.get(url);
    if (!pending) { pending = validate(segment); validation.set(url, pending); }
    return pending;
  };
  sources.setSegmentGate(gate);
  // Initial children are already cached by the full Inputs while their tracks/configurations are read.
  const initial = new Set<string>();
  for (const segment of descriptors) if (!initial.has(segment.playlistUrl)) {
    initial.add(segment.playlistUrl); await gate(segment.url);
  }
}
