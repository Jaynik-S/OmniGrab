/** Browser download contracts. Detection sources remain HLS; the saved output is MP4. */
export interface DownloadStartRequest {
  requestId: string; tabId: number; epoch: number; mediaId: string;
  instance: number; variantId?: string; filename?: string;
}
export interface DownloadSelection {
  tabId: number; epoch: number; mediaId: string; instance: number;
  pageUrl: string; frameId: number; documentId: string;
  sourceUrl: string; videoUrl: string; audioUrl?: string;
  /** Undefined means the fresh master chooses its highest normal video. */
  requestedVariantId?: string;
  width?: number; height?: number; filename: string; output: 'mp4';
}
export interface ByteRange { start: number; end: number; }
export interface ResourceGrant { url: string; range?: ByteRange; }
export interface DownloadPlan {
  selection: DownloadSelection;
  /** Requested and final URL aliases share text whose resource URIs are absolute. */
  manifests: Array<{ url: string; text: string }>;
  resources: ResourceGrant[]; duration?: number;
}
export type ResourceFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export interface SeekableOutput {
  write(data: Uint8Array, position: number): Promise<void>;
  flush(): Promise<void>; close(): Promise<void>;
}
export interface RemuxProgress {
  phase: 'processing' | 'finalizing'; inputBytes: number;
  outputBytes: number; seconds?: number; duration?: number;
}
export interface RemuxResult {
  bytes: number; duration: number;
  video: { codec: string; width: number; height: number };
  audio: { codec: string; channels: number; sampleRate: number };
}
export type DownloadPhase = 'queued' | 'resolving' | 'processing' | 'ready-to-save' | 'saving' |
  'complete' | 'failed' | 'canceled' | 'interrupted';
export interface DownloadAttachmentIdentity {
  jobId: string; capability: string; tabId: number; frameId: number; documentId: string;
}
export interface DownloadJob {
  version: 1; id: string; requestId: string; selection: DownloadSelection;
  phase: DownloadPhase; createdAt: number; updatedAt: number;
  progress: RemuxProgress;
  tempFile?: string; browserDownloadId?: number;
  attachment?: DownloadAttachmentIdentity;
  saveIntent?: { objectUrl: string; attemptedAt: number };
  failure?: { code: string; message: string };
}
export interface DownloadState { version: 1; jobs: DownloadJob[]; }
