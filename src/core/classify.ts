import type { DetectionStatus, MediaKind, Observation } from './model.ts';
import { normalizeUrl } from './identity.ts';

export interface Classification { kind: MediaKind; status: DetectionStatus; probe: boolean; reason?: string }
const hls = new Set(['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl']);
const fragment = /(?:\.(?:m4s|ts|m2ts|cmfv|cmfa)$|(?:^|\/)(?:init(?:ialization)?(?:[._-][^/]*)?|(?:segment|chunk)[-_]?\d+)\.mp4$)/i;
const nonMedia = /^(?:text\/(?:html|css)|image\/|application\/(?:json|javascript))/;

/** Negative response evidence also matters for candidates discovered before the response. */
export function rejectedResponseReason(o: Observation): string | undefined {
  if (o.method !== 'network') return;
  if (o.statusCode !== undefined && (o.statusCode < 200 || o.statusCode >= 300)) return `network-http:${o.statusCode}`;
  const mime = o.mime?.split(';')[0].trim().toLowerCase();
  if (mime && nonMedia.test(mime)) return `network-mime:${mime}`;
}

export function classify(o: Observation): Classification | undefined {
  if (o.url.startsWith('blob:') && o.method === 'dom') return { kind: 'blob', status: 'unresolved', probe: false, reason: 'local-blob-without-remote-link' };
  const url = normalizeUrl(o.url);
  if (!url || (o.statusCode !== undefined && (o.statusCode < 200 || o.statusCode >= 300))) return;
  const mime = o.mime?.split(';')[0].trim().toLowerCase();
  const path = new URL(url).pathname;
  if (fragment.test(path) || mime === 'video/mp2t') return;
  // Explicit contradictory response metadata overrides a suggestive filename.
  if (mime && nonMedia.test(mime)) return;
  if (hls.has(mime ?? '')) return { kind: 'hls', status: 'observed', probe: true };
  if (mime === 'application/dash+xml') return { kind: 'dash', status: 'observed', probe: true };
  const mediaMime = mime?.startsWith('video/') || mime?.startsWith('audio/') || mime === 'application/ogg';
  if (!mediaMime && /\.m3u8$/i.test(path)) return { kind: 'hls', status: 'observed', probe: true };
  if (!mediaMime && /\.mpd$/i.test(path)) return { kind: 'dash', status: 'observed', probe: true };
  const suffix = /\.(?:mp4|webm|mkv|mov|m4v|ogv|ogg|mp3|m4a|aac|wav|flac)$/i.test(path);
  if (!mediaMime && !suffix && o.method !== 'dom') return;
  if (mime && !mediaMime && !['application/octet-stream', 'binary/octet-stream'].includes(mime)) return;
  const positive = (value: number | undefined) => value !== undefined && Number.isFinite(value) && value > 0;
  const loadedMetadata = o.method === 'dom' && o.role !== 'alternative' && (positive(o.duration) || positive(o.width) && positive(o.height));
  return { kind: 'direct', status: o.method === 'network' && mediaMime || loadedMetadata ? 'confirmed' : 'observed', probe: false };
}
