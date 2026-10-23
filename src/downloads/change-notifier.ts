/** Coalesce status changes without queuing coordinator RPCs behind its lifecycle lock. */
export function createChangeNotifier(send: () => Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false; let urgent = false; let running = false; let disposed = false; let nextAt = 0;
  function pump() {
    if (disposed || running || !pending) return;
    if (timer !== undefined) {
      if (!urgent) return;
      clearTimeout(timer); timer = undefined;
    }
    const delay = urgent ? 0 : Math.max(0, nextAt - Date.now());
    if (delay) { timer = setTimeout(() => { timer = undefined; pump(); }, delay); return; }
    pending = false; urgent = false; running = true; nextAt = Date.now() + 1000;
    void Promise.resolve().then(() => { if (!disposed) return send(); }).catch(() => {}).finally(() => { running = false; pump(); });
  }
  return {
    notify(immediate = false) { if (disposed) return; pending = true; urgent ||= immediate; pump(); },
    // Never await the outstanding send: coordinator cleanup may own the lock it needs.
    dispose() { disposed = true; pending = false; urgent = false; clearTimeout(timer); timer = undefined; },
  };
}
