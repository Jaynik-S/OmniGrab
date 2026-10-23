import type { InputAudioTrack, InputVideoTrack } from 'mediabunny';
import type { DownloadPlan } from './model.ts';
import { parseDownloadHls } from './hls-plan.ts';
import type { RemuxSourceAdapter } from './remux-source.ts';

function signature(value: unknown): string {
  if (value instanceof ArrayBuffer) return [...new Uint8Array(value)].join(',');
  if (ArrayBuffer.isView(value)) return [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)].join(',');
  if (value && typeof value === 'object') return Object.keys(value).sort().map(key => `${key}:${signature((value as Record<string, unknown>)[key])}`).join('|');
  return JSON.stringify(value);
}

/** Keep current MAP and resolved inclusive byte ranges; timing remains owned by the original Input. */
function* segmentPlaylists(plan: DownloadPlan, url: string): Generator<string> {
  const manifest = plan.manifests.find(entry => entry.url === url);
  if (!manifest) throw new Error('Selected playlist is missing');
  const parsed = parseDownloadHls(manifest.text, url, url);
  if (parsed.master) throw new Error('Selected playlist must contain media');
  let map = ''; let duration = ''; let resource = 0;
  for (const raw of parsed.text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-MAP:')) { map = line; resource++; }
    else if (line.startsWith('#EXTINF:')) duration = line;
    else if (line && !line.startsWith('#')) {
      const grant = parsed.resources[resource++]!;
      const range = grant.range ? `#EXT-X-BYTERANGE:${grant.range.end - grant.range.start + 1}@${grant.range.start}` : '';
      const target = Math.max(1, Math.ceil(Number.parseFloat(duration.slice('#EXTINF:'.length))));
      yield ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${target}`, map, duration, range, line, '#EXT-X-ENDLIST'].filter(Boolean).join('\n');
    }
  }
}

/** Public segmented getters only expose the first track. Probe each segment's actual track separately. */
export async function validateSegmentConfigurations(plan: DownloadPlan, sources: RemuxSourceAdapter,
  video: InputVideoTrack, audio: InputAudioTrack): Promise<void> {
  const expectedVideo = signature({ codec: await video.getCodec(), width: await video.getCodedWidth(),
    height: await video.getCodedHeight(), config: await video.getDecoderConfig() });
  const expectedAudio = signature({ codec: await audio.getCodec(), config: await audio.getDecoderConfig() });
  const separateAudio = plan.selection.audioUrl !== plan.selection.videoUrl ? plan.selection.audioUrl : undefined;
  const playlists = [{ url: plan.selection.videoUrl, video: true, audio: !separateAudio },
    ...(separateAudio ? [{ url: separateAudio, video: false, audio: true }] : [])];
  for (const playlist of playlists) {
    for (const text of segmentPlaylists(plan, playlist.url)) {
      sources.check();
      const probe = sources.open(playlist.url, text);
      try {
        if (playlist.video) {
          const actual = await probe.getPrimaryVideoTrack();
          if (!actual || signature({ codec: await actual.getCodec(), width: await actual.getCodedWidth(),
            height: await actual.getCodedHeight(), config: await actual.getDecoderConfig() }) !== expectedVideo)
            throw new Error('Video decoder configuration or dimensions change between HLS segments');
        }
        if (playlist.audio) {
          const actual = await probe.getPrimaryAudioTrack();
          if (!actual || signature({ codec: await actual.getCodec(), config: await actual.getDecoderConfig() }) !== expectedAudio)
            throw new Error('Audio decoder configuration changes between HLS segments');
        }
      } finally { sources.release(probe); }
    }
  }
}
