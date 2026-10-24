import type { RemuxProgress } from './model.ts';

/** Retain only the latest packet counters between worker-to-host notifications. */
export function createWorkerProgress(send: (progress: RemuxProgress) => void, intervalMs = 250) {
  let latest: RemuxProgress | undefined;
  let published: RemuxProgress | undefined;
  let publishedAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const flush = () => {
    clearTimeout(timer); timer = undefined;
    if (disposed || !latest) return;
    const value = latest; latest = undefined;
    published = value; publishedAt = Date.now();
    send(value);
  };
  return {
    push(progress: RemuxProgress) {
      if (disposed) return;
      latest = progress;
      const remaining = intervalMs - (Date.now() - publishedAt);
      if (!published || progress.phase !== published.phase || published.inputBytes === 0 && progress.inputBytes > 0 || remaining <= 0) flush();
      else if (timer === undefined) timer = setTimeout(flush, remaining);
    },
    flush,
    dispose() {
      disposed = true; latest = undefined;
      clearTimeout(timer); timer = undefined;
    },
  };
}
