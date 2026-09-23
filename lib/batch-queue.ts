export interface QueueProgress {
  completed: number;
  total: number;
  elapsedMs: number;
}
/** Bounded workers stop claiming new items on pause; in-flight work finishes. */
export async function runBatch<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
  options: {
    paused?: () => boolean;
    progress?: (progress: QueueProgress) => void;
  } = {},
) {
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error("Invalid concurrency");
  let cursor = 0,
    completed = 0;
  const start = Date.now();
  const errors: unknown[] = [];
  const report = () =>
    options.progress?.({
      completed,
      total: items.length,
      elapsedMs: Date.now() - start,
    });
  report();
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length && !options.paused?.()) {
        const item = items[cursor++];
        try {
          await worker(item);
        } catch (e) {
          errors.push(e);
        }
        completed++;
        report();
      }
    }),
  );
  return { completed, total: items.length, errors };
}
