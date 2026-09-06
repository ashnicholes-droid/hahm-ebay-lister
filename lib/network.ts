import { AsyncLocalStorage } from "node:async_hooks";
const deadlines = new AsyncLocalStorage<number>();
export function withDeadline<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  return deadlines.run(
    Math.min(deadlines.getStore() ?? Infinity, Date.now() + ms),
    fn,
  );
}
export function remainingTime(cap = 30_000): number {
  const ms = Math.min(cap, (deadlines.getStore() ?? Infinity) - Date.now());
  if (ms < 100)
    throw new Error(
      "This operation reached its time limit. Your draft is saved; retry the unfinished step.",
    );
  return ms;
}
export async function boundedFetch(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const timeout = AbortSignal.timeout(remainingTime());
  return fetch(input, {
    ...init,
    signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  });
}
