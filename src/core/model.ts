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

export interface ManifestInfo {
  type: 'hls' | 'dash';
  variants: Variant[];
  childUrls: string[];
  segmentUrls: string[];
  live: boolean;
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
  protected?: boolean;
  live?: boolean;
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
  attempts?: number;
}
