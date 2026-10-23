import type { DownloadJob, RemuxProgress } from './model.ts';
import type { DownloadAttachment } from './transport.ts';
export interface HostStatus {
 jobId: string; phase: 'resolving' | 'processing' | 'ready-to-save' | 'failed';
 /** False until run is accepted; recovery interrupts this incomplete bootstrap instead of adopting it. */
 started: boolean;
 progress?: RemuxProgress; tempFile?: string; objectUrl?: string; error?: string;
}
export interface DownloadHost {
 status(): Promise<HostStatus[]>;
 prepare(job: DownloadJob): Promise<DownloadAttachment>;
 run(id: string): Promise<void>;
 cancel(id: string): Promise<void>;
 confirm(id: string, capability: string): Promise<void>;
 release(job: DownloadJob): Promise<void>;
 sweep(retained: string[]): Promise<void>;
}
export const OPFS_NAMESPACE = 'media-downloads-v1';
