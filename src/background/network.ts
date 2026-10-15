import type { Observation } from '../core/model.ts';

export interface RequestIdentity { requestId: string; tabId: number; frameId: number; documentId?: string }
export interface RequestContext { epoch: number; pageUrl: string }
interface ResponseDetails extends RequestIdentity { url: string; statusCode: number; responseHeaders?: chrome.webRequest.HttpHeader[] }

/** Memory-only request fence. A response without its start context cannot acquire a newer generation. */
export class RequestTracker {
  private readonly requests = new Map<string, { identity: RequestIdentity; context: Promise<RequestContext | undefined> }>();
  private readonly limit: number;
  constructor(limit = 1000) { this.limit = limit; }
  start(identity: RequestIdentity, context: Promise<RequestContext | undefined>): void {
    if (identity.tabId < 0) return;
    this.requests.set(identity.requestId, { identity, context });
    if (this.requests.size > this.limit) this.requests.delete(this.requests.keys().next().value!);
  }
  finish(id: string): void { this.requests.delete(id); }
  async response(details: ResponseDetails): Promise<Observation | undefined> {
    const request = this.requests.get(details.requestId); this.finish(details.requestId);
    if (!request || details.tabId < 0) return;
    const context = await request.context;
    if (!context) return;
    const header = (name: string) => details.responseHeaders?.find(h => h.name.toLowerCase() === name)?.value;
    const total = header('content-range')?.match(/\/(\d+)$/)?.[1] ?? header('content-length');
    const bytes = total && /^\d+$/.test(total) ? Number(total) : undefined;
    return { tabId: request.identity.tabId, frameId: request.identity.frameId,
      documentId: request.identity.documentId ?? details.documentId, epoch: context.epoch, pageUrl: context.pageUrl,
      url: details.url, mime: header('content-type'), statusCode: details.statusCode,
      bytes: Number.isSafeInteger(bytes) ? bytes : undefined, method: 'network', observedAt: Date.now() };
  }
}
