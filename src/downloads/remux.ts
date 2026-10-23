import {
  EncodedAudioPacketSource, EncodedPacketSink, EncodedVideoPacketSource, Mp4OutputFormat, Output, StreamTarget,
} from 'mediabunny';
import { RemuxSourceAdapter } from './remux-source.ts';
import { validateSegmentConfigurations } from './remux-validation.ts';
import type { DownloadPlan, RemuxProgress, RemuxResult, ResourceFetch, SeekableOutput } from './model.ts';

export interface RemuxOptions {
  fetcher: ResourceFetch;
  output: SeekableOutput;
  signal: AbortSignal;
  onProgress?: (progress: RemuxProgress) => void;
}

/** Copies the selected clear HLS packets; never invokes a decoder, encoder, or conversion fallback. */
export async function remuxToMp4(plan: DownloadPlan, options: RemuxOptions): Promise<RemuxResult> {
  const { output: disk, signal, onProgress, fetcher } = options;
  let muxer: Output | undefined;
  let completed = false;
  let inputBytes = 0;
  let outputBytes = 0;
  let seconds = 0;
  const sources = new RemuxSourceAdapter(plan, fetcher, signal, bytes => { inputBytes += bytes; progress('processing'); });
  const progress = (phase: RemuxProgress['phase']) => onProgress?.({ phase, inputBytes, outputBytes, seconds, duration: plan.duration });
  const check = () => sources.check();
  try {
    check();
    const videoInput = sources.open(plan.selection.videoUrl);
    const audioInput = plan.selection.audioUrl && plan.selection.audioUrl !== plan.selection.videoUrl ? sources.open(plan.selection.audioUrl) : videoInput;
    const video = await videoInput.getPrimaryVideoTrack();
    const audio = await audioInput.getPrimaryAudioTrack();
    check();
    if (!video || !audio) throw new Error('Required video or audio track is missing');
    const [videoCodec, audioCodec, videoConfig, audioConfig] = await Promise.all([
      video.getCodec(), audio.getCodec(), video.getDecoderConfig(), audio.getDecoderConfig(),
    ]);
    // MPEG-TS uses Annex B AVC and ADTS AAC (no description). The MP4 muxer validates
    // their priming packets and derives AVCC/AudioSpecificConfig without re-encoding.
    if (videoCodec !== 'avc' || audioCodec !== 'aac' || !videoConfig || !audioConfig ||
      !/^avc[13]\./.test(videoConfig.codec) || !/^mp4a\.40\./.test(audioConfig.codec))
      throw new Error('Unsupported video/audio codec or decoder configuration');
    const width = await video.getCodedWidth(); const height = await video.getCodedHeight();
    if (plan.selection.width !== undefined && width !== plan.selection.width || plan.selection.height !== undefined && height !== plan.selection.height)
      throw new Error('Selected video dimensions do not match the media');
    if (!width || !height || !audioConfig.numberOfChannels || !audioConfig.sampleRate) throw new Error('Invalid video/audio configuration');
    await validateSegmentConfigurations(plan, sources, video, audio);
    const videoSource = new EncodedVideoPacketSource(videoCodec);
    const audioSource = new EncodedAudioPacketSource(audioCodec);
    muxer = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(new WritableStream({
      async write(chunk) {
        check(); await disk.write(chunk.data, chunk.position); check();
        outputBytes = Math.max(outputBytes, chunk.position + chunk.data.byteLength);
      },
    })) });
    muxer.addVideoTrack(videoSource); muxer.addAudioTrack(audioSource);
    await muxer.start();
    const videoSink = new EncodedPacketSink(video); const audioSink = new EncodedPacketSink(audio);
    let v = await videoSink.getFirstPacket(); let a = await audioSink.getFirstPacket();
    let firstVideo = true; let firstAudio = true;
    let videoDuration = 0; let audioDuration = 0; let start = Infinity; let finish = -Infinity;
    let videoPacketDuration = 0; let audioPacketDuration = 0;
    while (v || a) {
      check();
      // Keep only one packet from each track. Each sink advances in decode order, even for B frames.
      const takeVideo = v && (!a || v.timestamp <= a.timestamp);
      const packet = takeVideo ? v! : a!;
      if (!Number.isFinite(packet.timestamp) || !Number.isFinite(packet.duration) || packet.duration <= 0 || !packet.data.length)
        throw new Error('Invalid or truncated media packet');
      start = Math.min(start, packet.timestamp); finish = Math.max(finish, packet.timestamp + packet.duration);
      if (takeVideo) {
        await videoSource.add(packet, firstVideo ? { decoderConfig: videoConfig } : undefined);
        videoPacketDuration = Math.max(videoPacketDuration, packet.duration);
        firstVideo = false; videoDuration += packet.duration; v = await videoSink.getNextPacket(packet);
      } else {
        await audioSource.add(packet, firstAudio ? { decoderConfig: audioConfig } : undefined);
        audioPacketDuration = Math.max(audioPacketDuration, packet.duration);
        firstAudio = false; audioDuration += packet.duration; a = await audioSink.getNextPacket(packet);
      }
      seconds = finish - start; progress('processing');
    }
    check();
    // EXTINF may include the final partial frame/audio packet. Permit one packet's
    // quantization plus 1 ms rounding, rather than hiding a fixed 250 ms deficit.
    if (firstVideo || firstAudio || plan.duration !== undefined &&
      (videoDuration + videoPacketDuration + 0.001 < plan.duration || audioDuration + audioPacketDuration + 0.001 < plan.duration))
      throw new Error('Truncated video or audio track');
    videoSource.close(); audioSource.close(); progress('finalizing');
    await muxer.finalize(); check(); await disk.flush(); await disk.close();
    completed = true; progress('finalizing');
    return { bytes: outputBytes, duration: finish - start, video: { codec: videoCodec, width, height },
      audio: { codec: audioCodec, channels: audioConfig.numberOfChannels, sampleRate: audioConfig.sampleRate } };
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    throw error;
  } finally {
    sources.dispose();
    if (!completed) {
      if (muxer && muxer.state !== 'finalized' && muxer.state !== 'canceled') await muxer.cancel().catch(() => {});
      await disk.close();
    }
  }
}
