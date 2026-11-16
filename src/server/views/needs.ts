// What waits on a reader: the tool calls of threads that wait for a person, each with whether the
// reader may act on it and the risk its tool's policy gives it now, and what a thread's list shows
// of its run and of those calls.

import type { Run } from "@/server/execution/execution.ts";

import type { Calls, WaitingCall } from "@/server/calls/calls.ts";

export interface NeedsOptions {
  // The tool calls and the jobs tools start or people move there, when given.
  calls?: Pick<Calls, "find" | "waitingOn">;
}

export type Needs = ReturnType<typeof createNeeds>;

// Who the calls are read for, with what was read already for their other calls in the request.
type WaitReader = Parameters<Calls["waitingOn"]>[0];

export function createNeeds(options: NeedsOptions) {
  const { calls } = options;

  // The thread's active run as its list shows it, and whether the reader may decide on a call that
  // waits: the one its run waits for, or a job that waits while the run goes on or has ended,
  // given the thread's calls that wait. A call the reader may decide shows the thread as waiting
  // for them, over its working.
  function runActivity(run: Run | undefined, waiting: readonly WaitingCall[]) {
    const own = ownActivity(run, waiting);
    if (own.needsYou) return own;
    const job = waiting.find((one) => one.call.background && one.canAct);
    if (!job) return own;
    return {
      run: { status: "waiting" as const, since: job.row.requestedAt, toolId: job.row.toolId },
      needsYou: true,
    };
  }

  function ownActivity(run: Run | undefined, waiting: readonly WaitingCall[]) {
    if (!run) return { run: null, needsYou: false };
    const since = (run.startedAt ?? run.createdAt).toISOString();
    if (run.status !== "waiting") {
      return {
        run: {
          status: run.status === "queued" ? ("queued" as const) : ("running" as const),
          since,
        },
        needsYou: false,
      };
    }
    const call = runWaitsOn(run, waiting);
    return {
      run: {
        status: "waiting" as const,
        since: call?.row.requestedAt ?? since,
        ...(call && { toolId: call.row.toolId }),
      },
      needsYou: call?.canAct ?? false,
    };
  }

  // The call the run waits on, of the calls that wait: its first.
  function runWaitsOn(run: Pick<Run, "id">, waiting: readonly WaitingCall[]) {
    return waiting.find((one) => !one.call.background && one.call.runId === run.id) ?? null;
  }

  // The calls of the threads that wait for a person, by thread, in the order they were asked for.
  async function waitingIn(reader: WaitReader, threadIds: readonly string[]) {
    const found = (await calls?.waitingOn(reader, threadIds)) ?? [];
    return Map.groupBy(
      found.toSorted((a, b) => a.row.seq - b.row.seq),
      (one) => one.call.threadId,
    );
  }

  // What a waiting call waits for, by its row.
  async function callWaitsFor(threadId: string, callId: string) {
    return (await calls?.find(threadId, callId))?.waitsFor ?? null;
  }

  return {
    // The calls of the threads that wait for a person, by thread, in the order they were asked
    // for, each with whether the reader may act on it.
    of: async (reader: WaitReader, threadIds: readonly string[]) => waitingIn(reader, threadIds),
    standing: runActivity,
    runWaitsOn,
    waitsFor: callWaitsFor,
  };
}
