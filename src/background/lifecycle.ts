interface FrameLifecycle { token: bigint; pending: boolean }
interface TabLifecycle {
  token: bigint;
  pending: boolean;
  closed: boolean;
  frames: Map<number, FrameLifecycle>;
  unknownFramesBlocked: boolean;
}
export interface LifecycleToken { tabId: number; frameId: number; tab: bigint; frame: bigint }

/** Synchronous browser-event identities fence work waiting on Chrome or the store queue. */
export class DocumentLifecycle {
  // Never reset or reuse identities when a bounded entry is evicted or a tab ID returns.
  private next = 0n;
  private tabs = new Map<number, TabLifecycle>();
  private unknownTabsBlocked = false;

  private tab(tabId: number, browserEvent = false): TabLifecycle | undefined {
    const existing = this.tabs.get(tabId);
    if (existing) return existing;
    if (this.unknownTabsBlocked && !browserEvent) return;
    if (this.tabs.size >= 1000) {
      // Never evict a pending navigation: forgetting it would reopen its old document.
      const idle = [...this.tabs].find(([, tab]) => !tab.pending && ![...tab.frames.values()].some(frame => frame.pending));
      if (!idle) { this.unknownTabsBlocked = true; return; }
      this.tabs.delete(idle[0]);
    }
    const tab: TabLifecycle = { token: ++this.next, pending: false, closed: false, frames: new Map(), unknownFramesBlocked: false };
    this.tabs.set(tabId, tab);
    return tab;
  }

  private frame(tab: TabLifecycle, frameId: number, browserEvent = false): FrameLifecycle | undefined {
    const existing = tab.frames.get(frameId);
    if (existing) return existing;
    if (tab.unknownFramesBlocked && !browserEvent) return;
    if (tab.frames.size >= 100) {
      const idle = [...tab.frames].find(([, frame]) => !frame.pending);
      if (!idle) { tab.unknownFramesBlocked = true; return; }
      tab.frames.delete(idle[0]);
    }
    const frame = { token: ++this.next, pending: false };
    tab.frames.set(frameId, frame);
    return frame;
  }

  capture(tabId: number, frameId: number): LifecycleToken | undefined {
    const tab = this.tab(tabId);
    if (!tab || tab.closed || tab.pending) return;
    const frame = this.frame(tab, frameId);
    if (!frame || frame.pending) return;
    return { tabId, frameId, tab: tab.token, frame: frame.token };
  }

  current(token: LifecycleToken | undefined): boolean {
    if (!token) return false;
    const tab = this.tabs.get(token.tabId);
    const frame = tab?.frames.get(token.frameId);
    return !!tab && !tab.closed && !tab.pending && tab.token === token.tab &&
      !!frame && !frame.pending && frame.token === token.frame;
  }

  before(tabId: number, frameId: number): void {
    const tab = this.tab(tabId, true);
    if (!tab) return;
    if (frameId === 0) {
      tab.token = ++this.next; tab.pending = true; tab.closed = false;
      tab.frames.clear(); tab.unknownFramesBlocked = false;
    } else if (!tab.closed && !tab.pending) {
      const frame = this.frame(tab, frameId, true);
      if (frame) { frame.token = ++this.next; frame.pending = true; }
    }
  }

  committed(tabId: number, frameId: number): { pending: boolean } | undefined {
    const tab = this.tab(tabId, true);
    if (!tab) return;
    if (frameId === 0) {
      const pending = tab.pending;
      tab.token = ++this.next; tab.pending = false; tab.closed = false;
      tab.frames.clear(); tab.unknownFramesBlocked = false;
      return { pending };
    }
    if (tab.closed || tab.pending) return;
    const frame = this.frame(tab, frameId, true);
    if (!frame) return;
    const pending = frame.pending;
    frame.token = ++this.next; frame.pending = false;
    return { pending };
  }

  failed(tabId: number, frameId: number): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    if (frameId === 0) { tab.token = ++this.next; tab.pending = false; }
    else {
      const frame = tab.frames.get(frameId);
      if (frame) { frame.token = ++this.next; frame.pending = false; }
    }
  }

  removed(tabId: number): void {
    const tab = this.tab(tabId, true);
    if (!tab) return;
    tab.token = ++this.next; tab.closed = true; tab.pending = false;
    tab.frames.clear();
  }
}
