export type MediaKind = 'direct' | 'hls' | 'dash' | 'blob' | 'unknown';
export type DetectionMethod = 'network' | 'dom' | 'resource' | 'manifest' | 'adapter';
export type DetectionStatus = 'observed' | 'probing' | 'confirmed' | 'unresolved' | 'unsupported';

export interface Variant {
  id: string;
  url?: string;
  kind?: 'video' | 'audio' | 'subtitles';
  bandwidth?: number;
  width?: number;
  height?: number;
  codecs?: string;
  language?: string;
  group?: string;
  audioGroup?: string;
  subtitleGroup?: string;
  representationId?: string;
}

/** Exact URL literals separated only by bounded decimal DASH Number/Time values. */
export type SegmentVariable = 'Number' | 'Time';
export interface SegmentPattern {
  literals: string[];
  minDigits: number[];
  variables: SegmentVariable[];
}

export interface ManifestInfo {
  type: 'hls' | 'dash';
  variants: Variant[];
  childUrls: string[];
  segmentUrls: string[];
  segmentPatterns?: SegmentPattern[];
  live?: boolean;
  protected: boolean;
  duration?: number;
  truncated?: number;
}

export interface Observation {
  tabId: number;
  frameId: number;
  documentId?: string;
  epoch?: number;
  url: string;
  method: DetectionMethod;
  observedAt?: number;
  pageUrl?: string;
  title?: string;
  mime?: string;
  statusCode?: number;
  bytes?: number;
  width?: number;
  height?: number;
  duration?: number;
  poster?: string;
  elementId?: string;
  role?: 'current' | 'alternative';
}

export interface MediaItem {
  id: string;
  /** Creation/document-membership revision; fences jobs across same-URL frame replacements. */
  instance?: number;
  /** Bounded automatic retry budget; explicit user rescans can start a new attempt. */
  probeAttempts?: number;
  url: string;
  type: MediaKind;
  status: DetectionStatus;
  methods: DetectionMethod[];
  frameIds: number[];
  documentIds: string[];
  elementIds: string[];
  firstSeen: number;
  lastSeen: number;
  mime?: string;
  bytes?: number;
  title?: string;
  width?: number;
  height?: number;
  duration?: number;
  poster?: string;
  reason?: string;
  variants: Variant[];
  childUrls: string[];
  segmentUrls: string[];
  segmentPatterns?: SegmentPattern[];
  protected?: boolean;
  live?: boolean;
  /** Observed HLS children plus at most one preferred rendition for metadata enrichment. */
  childManifests?: ChildManifest[];
}

export interface ChildManifest {
  url: string;
  instance?: number;
  probeAttempts?: number;
  status: 'observed' | 'probing' | 'confirmed' | 'unresolved';
  frameIds: number[];
  reason?: string;
}

export interface TabState {
  id: number;
  url: string;
  title?: string;
  epoch: number;
  documentId?: string;
  documents: Record<string, string>;
  media: Record<string, MediaItem>;
  updatedAt: number;
  dropped: number;
  errors: string[];
}

export interface Snapshot {
  version: 1;
  revision: number;
  tabs: Record<string, TabState>;
}

export interface ProbeJob {
  tabId: number;
  epoch: number;
  itemId: string;
  url: string;
  kind: 'hls' | 'dash';
  instance?: number;
  /** Owning master distinguishes shared rendition work in separate source groups. */
  ownerId?: string;
  /** Ephemeral shared transport deadline; derived at run time, never a durable job field. */
  expiresAt?: number;
  attempts?: number;
}
