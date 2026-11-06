/**
 * Bounded-wait helper for server-side data fetches.
 *
 * Rejects with a descriptive error after `ms` so pages and API routes never
 * hang indefinitely on a slow or unreachable database (the observed
 * production symptom on /dashboard). Callers convert the timeout into a
 * user-visible degraded/unavailable state — never silent empty data.
 */

export class TimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
