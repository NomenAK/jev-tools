import { CONCURRENCY, RATE_PER_SECOND } from "../constants.ts";

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
export interface Pool {
  acquire(signal?: AbortSignal): Promise<() => void>;
}

/** A fresh pool owns its sliding window; share it between clients in one process. */
export function createPool(
  clock: Clock,
  limits: { ratePerSecond?: number; concurrency?: number } = {},
): Pool {
  const ratePerSecond = limits.ratePerSecond ?? RATE_PER_SECOND;
  const concurrency = limits.concurrency ?? CONCURRENCY;
  let active = 0;
  const starts: number[] = [];
  let gate = Promise.resolve();
  let released = Promise.withResolvers<void>();
  return {
    async acquire(signal) {
      const previous = gate;
      const turn = Promise.withResolvers<void>();
      gate = turn.promise;
      await previous;
      try {
        for (;;) {
          signal?.throwIfAborted();
          const now = clock.now();
          while (starts.length && now - (starts[0] ?? now) >= 1_000)
            starts.shift();
          if (active >= concurrency) {
            const cancelled = Promise.withResolvers<void>();
            const abort = () => cancelled.reject(signal?.reason);
            signal?.addEventListener("abort", abort, { once: true });
            try {
              await Promise.race([released.promise, cancelled.promise]);
            } finally {
              signal?.removeEventListener("abort", abort);
            }
          } else if (starts.length >= ratePerSecond) {
            await clock.sleep(
              Math.max(1, 1_000 - (now - (starts[0] ?? now))),
              signal,
            );
          } else break;
        }
        active++;
        starts.push(clock.now());
        let done = false;
        return () => {
          if (done) return;
          done = true;
          active--;
          released.resolve();
          released = Promise.withResolvers<void>();
        };
      } finally {
        turn.resolve();
      }
    },
  };
}
