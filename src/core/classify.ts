import type { DetectionStatus, MediaKind, Observation } from './model.ts';
import { normalizeUrl } from './identity.ts';

export interface Classification { kind: MediaKind; status: DetectionStatus; probe: boolean; reason?: string }
const hls = new Set(['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl']);
const fragment = /(?:\.(?:m4s|ts|m2ts|cmfv|cmfa)$|(?:^|\/)(?:init(?:ialization)?(?:[._-][^/]*)?|(?:segment|chunk)[-_]?\d+)\.mp4$)/i;

export function classify(o: Observation): Classification | undefined {
  if (o.url.startsWith('blob:') && o.method === 'dom') return { kind: 'blob', status: 'unresolved', probe: false, reason: 'local-blob-without-remote-link' };
  const url = normalizeUrl(o.url);
  if (!url || (o.statusCode !== undefined && (o.statusCode < 200 || o.statusCode >= 300))) return;
  const mime = o.mime?.split(';')[0].trim().toLowerCase();
  const path = new URL(url).pathname;
  if (fragment.test(path) || mime === 'video/mp2t') return;
  // Explicit contradictory response metadata overrides a suggestive filename.
  if (mime && /^(?:text\/(?:html|css)|image\/|application\/(?:json|javascript))/.test(mime)) return;
  if (hls.has(mime ?? '') || /\.m3u8$/i.test(path)) return { kind: 'hls', status: 'observed', probe: true };
  if (mime === 'application/dash+xml' || /\.mpd$/i.test(path)) return { kind: 'dash', status: 'observed', probe: true };
  const mediaMime = mime?.startsWith('video/') || mime?.startsWith('audio/') || mime === 'application/ogg';
  const suffix = /\.(?:mp4|webm|mkv|mov|m4v|ogv|ogg|mp3|m4a|aac|wav|flac)$/i.test(path);
  if (!mediaMime && !suffix && o.method !== 'dom') return;
  if (mime && !mediaMime && !['application/octet-stream', 'binary/octet-stream'].includes(mime)) return;
  return { kind: 'direct', status: o.method === 'network' && mediaMime || o.method === 'dom' && o.role !== 'alternative' ? 'confirmed' : 'observed', probe: false };
}
