import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createLogger } from "@/server/kernel/logger.ts";

import { createKeeper } from "./keeper.ts";

const quiet = createLogger({ write() {} });

// Leases held in memory: each answers its renewals as the test says.
function leases(...names: string[]) {
  const held = new Set(names);
  const answers = new Map<string, () => Promise<boolean>>();
  const renewed: string[] = [];
  const lost: string[] = [];
  const steps: string[] = [];
  return {
    held,
    answers,
    renewed,
    lost,
    steps,
    options: {
      name: "test",
      everyMs: 100,
      held: () => held.values(),
      renew: async (lease: string) => {
        renewed.push(lease);
        steps.push(`renew ${lease}`);
        return (await answers.get(lease)?.()) ?? true;
      },
      onLost: (lease: string) => void lost.push(lease),
      sweep: async () => void steps.push("sweep"),
    },
  };
}

describe("keepers", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("renew every lease held, each beat, then sweep", async () => {
    const kept = leases("a", "b");
    const keeper = createKeeper(kept.options, quiet);
    await keeper.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(kept.steps).toEqual(["renew a", "renew b", "sweep", "renew a", "renew b", "sweep"]);
    await keeper.stop();
  });

  it("tell of a lease no longer held once, and renew it no more", async () => {
    const kept = leases("a");
    kept.answers.set("a", async () => false);
    const keeper = createKeeper(kept.options, quiet);
    await keeper.start();
    await vi.advanceTimersByTimeAsync(300);
    expect(kept.lost).toEqual(["a"]);
    expect(kept.renewed).toEqual(["a"]);
    await keeper.stop();
  });

  it("keep a lease whose renewal threw, for the next beat", async () => {
    const kept = leases("a");
    kept.answers.set("a", () => Promise.reject(new Error("down")));
    const keeper = createKeeper(kept.options, quiet);
    await keeper.start();
    kept.answers.delete("a");
    await vi.advanceTimersByTimeAsync(100);
    expect(kept.lost).toEqual([]);
    expect(kept.renewed).toEqual(["a", "a"]);
    await keeper.stop();
  });

  it("wait for the beat under way as they stop", async () => {
    const kept = leases("a");
    let release = () => {};
    kept.answers.set("a", () => new Promise<boolean>((resolve) => (release = () => resolve(true))));
    const keeper = createKeeper(kept.options, quiet);
    void keeper.start();
    let stopped = false;
    const stopping = keeper.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(kept.steps).toEqual(["renew a", "sweep"]);
  });
});
