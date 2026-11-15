// The rule schedules and webhooks keep together in a thread: at most a set number of both kinds
// live at once, and each named unlike every other of either kind. Both systems ask it before they
// set one; neither knows the other.

import type { Schedules } from "@/server/schedules/schedules.ts";
import type { Webhooks } from "@/server/webhooks/webhooks.ts";
import { SCHEDULES_AND_WEBHOOKS_LIMIT } from "@/shared/schedules-and-webhooks.ts";

export function createSetRule(deps: {
  schedules: Pick<Schedules, "inThread">;
  webhooks: Pick<Webhooks, "inThread">;
}) {
  // The thread's live ones of both kinds, each with what it is called in words.
  async function live(threadId: string) {
    const [timed, posted] = await Promise.all([
      deps.schedules.inThread(threadId),
      deps.webhooks.inThread(threadId),
    ]);
    return [
      ...timed.map((row) => ({ name: row.name, what: row.kind === "cron" ? "schedule" : "timer" })),
      ...posted.map((row) => ({ name: row.name, what: "webhook" })),
    ];
  }

  return {
    async room(threadId: string) {
      return (await live(threadId)).length >= SCHEDULES_AND_WEBHOOKS_LIMIT
        ? `This thread has ${SCHEDULES_AND_WEBHOOKS_LIMIT} schedules and webhooks. Delete some with schedules.delete or webhooks.delete first.`
        : null;
    },
    // A live one's name is its own in the thread, whatever the case.
    async unique(threadId: string, name: string) {
      const clash = (await live(threadId)).find(
        (one) => one.name.toLowerCase() === name.toLowerCase(),
      );
      return clash
        ? `A ${clash.what} named ${clash.name} already exists here; pick another name.`
        : null;
    },
  };
}
