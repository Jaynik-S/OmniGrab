import { isTrustedManifestSender } from './manifest-fetch.ts';
import { normalizeUrl } from '../core/identity.ts';
import { BINARY_PORT, BinaryGrants, produceBinary, validId } from '../downloads/binary-protocol.ts';
import type { BinaryMessage, BinaryPortMessage, ProducerControl } from '../downloads/binary-protocol.ts';
import type { DownloadSelection } from '../downloads/model.ts';

/** The sole content hook: a trusted coordinator attaches this document to its offscreen host. */
export function createDownloadAttachmentHandler(runtimeId: string, options: { fetcher?: typeof fetch; connect?: (name: string) => chrome.runtime.Port; pageUrl?: () => string } = {}) {
  const attached = new Set<string>();
  const sessions = new Map<string, { jobId: string; port: chrome.runtime.Port; active: Map<string, ProducerControl>; close: () => void }>();
  const settled = new Map<string, string>();
  return (message: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void): boolean | undefined => {
    const m = message as { type?: string; jobId: string; capability: string; selection: DownloadSelection; expiresAt: number };
    if (!m || m.type !== 'download-attach' && m.type !== 'download-detach') return;
    if (!isTrustedManifestSender(sender, runtimeId)) return false;
    if (m.type === 'download-detach') {
      const session = sessions.get(m.capability);
      if (!validId(m.jobId) || !session && settled.get(m.capability) !== m.jobId || session && session.jobId !== m.jobId) { reply({ ok: false, error: 'download-attachment-unknown' }); return false; }
      if (!session) { reply({ ok: true, jobId: m.jobId, capability: m.capability, settled: true }); return false; }
      session.close();
      void Promise.all([...session.active.values()].map(control => control.settled)).then(() => {
        session.port.disconnect(); sessions.delete(m.capability); settled.set(m.capability, m.jobId);
        if (settled.size > 128) settled.delete(settled.keys().next().value!);
        reply({ ok: true, jobId: m.jobId, capability: m.capability, settled: true });
      });
      return true;
    }
    try {
      if (!validId(m.jobId) || typeof m.capability !== 'string' || !/^[a-zA-Z0-9_-]{32,128}$/.test(m.capability) || attached.has(m.capability) || sessions.size >= 3 || !Number.isSafeInteger(m.expiresAt) || m.expiresAt <= Date.now() || m.expiresAt > Date.now() + 10_000 || !normalizeUrl(m.selection.pageUrl) || normalizeUrl(m.selection.pageUrl) !== normalizeUrl((options.pageUrl ?? (() => location.href))())) throw new Error('download-attachment-invalid');
      const grants = new BinaryGrants(); grants.add([m.selection.sourceUrl, m.selection.videoUrl, m.selection.audioUrl].filter((v): v is string => !!v).map(url => ({ url })));
      const unrestricted = new BinaryGrants(); unrestricted.add([m.selection.sourceUrl, m.selection.videoUrl, m.selection.audioUrl].filter((v): v is string => !!v).map(url => ({ url })));
      const port = (options.connect ?? (name => chrome.runtime.connect({ name })))(BINARY_PORT + JSON.stringify({ jobId: m.jobId, capability: m.capability }));
      attached.add(m.capability); const active = new Map<string, ProducerControl>(); const used = new Set<string>(); let ready = false, closing = false;
      const close = () => { closing = true; for (const c of active.values()) c.abort(); };
      if (attached.size > 128) attached.delete(attached.keys().next().value!);
      sessions.set(m.capability, { jobId: m.jobId, port, active, close });
      const send = (v: BinaryMessage) => { try { port.postMessage(v); } catch { close(); } };
      port.onMessage.addListener((value: unknown) => {
        const v = value as BinaryPortMessage;
        if (!v || v.jobId !== m.jobId || closing) return;
        if (v.type === 'grants') {
          try { grants.add(v.grants); unrestricted.add(v.grants.filter(g => !g.range)); ready = true; port.postMessage({ type: 'ready', jobId: m.jobId }); } catch { close(); port.disconnect(); }
        } else if (v.type === 'request') {
          const physicalActive = [...sessions.values()].reduce((total, session) => total + session.active.size, 0);
          if (!ready || physicalActive >= 4 || used.has(v.requestId) || used.size >= 100_000 || !validId(v.requestId)) { send({ type: 'error', jobId: m.jobId, requestId: v.requestId, error: 'download-request-invalid' }); return; }
          used.add(v.requestId);
          const control = produceBinary(v, { fetcher: options.fetcher ?? fetch, grants, unrestricted: unrestricted.permits(v.url), send });
          active.set(v.requestId, control); void control.settled.finally(() => active.delete(v.requestId));
        } else if (v.type === 'ack') active.get(v.requestId)?.ack(v.sequence, v.offset);
        else if (v.type === 'abort') active.get(v.requestId)?.abort();
      });
      port.onDisconnect.addListener(() => {
        close();
        void Promise.all([...active.values()].map(c => c.settled)).then(() => {
          sessions.delete(m.capability); settled.set(m.capability, m.jobId);
          if (settled.size > 128) settled.delete(settled.keys().next().value!);
        });
      });
      reply({ ok: true });
    } catch (error) { reply({ ok: false, error: String(error instanceof Error ? error.message : error) }); }
    return false;
  };
}
