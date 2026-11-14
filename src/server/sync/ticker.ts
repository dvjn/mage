// Periodic work: a pass now and then every so often, never two at once. A pass asked for while one
// is under way makes that one go round once more. A pass that throws is logged and the next runs
// as planned. The timer does not keep the process alive. A pass belongs to no trace, whoever asked
// for it.

import { context, ROOT_CONTEXT } from "@opentelemetry/api";

import type { Logger } from "@/server/kernel/logger.ts";

export interface Ticker {
  // A pass now, then one every period.
  start(): Promise<void>;
  // No more passes; resolves once the one under way is done.
  stop(): Promise<void>;
  // A pass now; while one is under way, it goes round once more, and this resolves after.
  now(): Promise<void>;
}

export function createTicker(
  name: string,
  pass: () => Promise<unknown>,
  everyMs: number,
  logger: Logger,
): Ticker {
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let running: Promise<void> | null = null;
  let again = false;

  function now(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = context.with(ROOT_CONTEXT, async () => {
      try {
        do {
          again = false;
          try {
            await pass();
          } catch (err) {
            logger.error({ err, ticker: name }, "periodic pass failed");
          }
        } while (again && !stopped);
      } finally {
        running = null;
      }
    });
    return running;
  }

  return {
    async start() {
      if (timer) return;
      stopped = false;
      timer = setInterval(() => void now(), everyMs);
      timer.unref();
      await now();
    },

    async stop() {
      stopped = true;
      clearInterval(timer);
      timer = undefined;
      await running;
    },

    now,
  };
}
