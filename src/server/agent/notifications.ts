// Notifications: what a thread's agent is told from outside its thread, by other agents or of the
// work it started, each with where it came from and everyone whose words it carries. One waits in
// the thread like a person's message: a busy agent takes in every one waiting at its next pause,
// never during a tool call, and an idle one is started on them. It is left in the same write that
// checks for a run under way, so one arriving as a run ends is either taken up by that run's end,
// which starts the next run on it, or starts one itself.

import type { EventBus } from "@/server/kernel/event-bus.ts";
import { type Append, eventSummary, type ThreadLog } from "@/server/threads/log.ts";
import type { ThreadStore } from "@/server/threads/service.ts";
import type {
  NotificationKind,
  NotificationParts,
  NotificationSource,
  Steering,
  SubagentTask,
} from "@/shared/threads/events.ts";
import { transcriptOf } from "@/shared/transcript.ts";

import { type RunStore, startRun } from "./runs.ts";

export interface Notification extends NotificationParts {
  kind: NotificationKind;
  source: NotificationSource;
  text: string;
  people: Steering[];
  // For a message, whom it was sent to, and for a subagent's first, its task.
  to?: string;
  task?: SubagentTask;
}

export interface NotifierOptions {
  threads: Pick<ThreadStore, "eventsAfter">;
  runs: Pick<RunStore, "active" | "create">;
  log: ThreadLog;
  bus: EventBus;
  // Whether the thread's agent may be started on what waits for it now; always when not given.
  mayStart?: (threadId: string) => boolean;
}

export type Notifier = ReturnType<typeof createNotifier>;

export function createNotifier(options: NotifierOptions) {
  const { threads, runs, log, bus } = options;
  const mayStart = options.mayStart ?? (() => true);

  // Starts the thread's agent on the notifications waiting for it, when it is idle and may run.
  function startIfFree(threadId: string, append: Append) {
    if (runs.active(threadId)) return;
    const { inbox } = transcriptOf(threads.eventsAfter(threadId, 0).map(eventSummary));
    if (inbox.length === 0 || !mayStart(threadId)) return;
    startRun(
      runs,
      append,
      { threadId, triggerSeq: inbox[0]!.seq, createdBy: null },
      inbox.map((message) => message.id),
    );
  }

  return {
    // Leaves the notification in the thread, and starts its agent on it when it is idle.
    send(threadId: string, notification: Notification) {
      const { result } = log.write(threadId, (append) => {
        const stored = append({
          type: "notification",
          actor: { kind: "agent" },
          data: notification,
        });
        startIfFree(threadId, append);
        return stored;
      });
      bus.wake(threadId);
      return result;
    },

    // Starts the thread's agent on what waits for it, when it is idle and now may run.
    wake(threadId: string) {
      log.write(threadId, (append) => startIfFree(threadId, append));
      bus.wake(threadId);
    },
  };
}
