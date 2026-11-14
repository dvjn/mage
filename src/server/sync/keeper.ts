// Keeps the leases this instance holds: every beat renews each, tells of those no longer its own,
// then takes over or ends what other instances left behind. A renewal that throws keeps the lease
// for the next beat.

import type { Logger } from "@/server/kernel/logger.ts";

import { createTicker } from "./ticker.ts";

export interface KeeperOptions<L> {
  name: string;
  // A third of the lease, so two beats can fail before it runs out.
  everyMs: number;
  // The leases this instance holds now.
  held(): Iterable<L>;
  // False when the lease is no longer this instance's.
  renew(lease: L): Promise<boolean>;
  onLost(lease: L): void;
  // Takes over or ends what others left, through the owner's own guarded statements.
  sweep?(): Promise<void>;
}

export interface Keeper {
  // A beat now, then one every period.
  start(): Promise<void>;
  // No more beats; resolves once the one under way is done.
  stop(): Promise<void>;
  // A beat now, or once more after the one under way.
  beat(): Promise<void>;
}

export function createKeeper<L>(options: KeeperOptions<L>, logger: Logger): Keeper {
  // Leases told of as lost, renewed no more while they are still listed as held.
  let lost = new Set<L>();

  async function beat() {
    const held = [...options.held()];
    lost = new Set(held.filter((lease) => lost.has(lease)));
    for (const lease of held) {
      if (lost.has(lease)) continue;
      let ours: boolean;
      try {
        ours = await options.renew(lease);
      } catch (err) {
        logger.error({ err, keeper: options.name }, "lease not renewed");
        continue;
      }
      if (ours) continue;
      lost.add(lease);
      options.onLost(lease);
    }
    await options.sweep?.();
  }

  const ticker = createTicker(options.name, beat, options.everyMs, logger);
  return { start: () => ticker.start(), stop: () => ticker.stop(), beat: () => ticker.now() };
}
