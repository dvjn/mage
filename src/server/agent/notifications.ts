// Notifications: what a thread's agent is told from outside its thread, by other agents or of the
// work it started, each with where it came from and everyone whose words it carries. One waits in
// the thread like a person's message: a busy agent takes in every one waiting at its next pause,
// never during a tool call, and an idle one is started on them, unless they are silent: those are
// read the same way but start no run. It is left in the same write that
// checks for a run under way, so one arriving as a run ends is either taken up by that run's end,
// which starts the next run on it, or starts one itself.

import type { EventBus } from "@/server/kernel/event-bus.ts";
import { type Append, eventSummary, type ThreadLog } from "@/server/threads/log.ts";
import type { ThreadStore } from "@/server/threads/service.ts";
import type {
  Change,
  NotificationActor,
  NotificationKind,
  NotificationParts,
  NotificationSource,
  Steering,
  SubagentTask,
} from "@/shared/threads/events.ts";
import { transcriptOf, waking } from "@/shared/transcript.ts";

import { type RunStore, startRun } from "./runs.ts";

export interface Notification extends NotificationParts {
  kind: NotificationKind;
  source: NotificationSource;
  // Who it is shown as coming from; for an agent's message or report, the agent it came from.
  actor?: NotificationActor;
  text: string;
  people: Steering[];
  // For a message, whom it was sent to, and for a subagent's first, its task.
  to?: string;
  task?: SubagentTask;
  // False to leave it for the agent to read at its next model call or run, without starting it.
  wake?: boolean;
}

// A change someone else made to what the thread's agent owns or watches, told without starting it:
// shown where it was made and read by the agent at its next model call or run. `by` is who did it,
// and `text` says what, starting with their name.
export function silentChange(
  threadId: string,
  by: string,
  text: string,
  tray?: NotificationParts["tray"],
  actor?: NotificationActor,
  change?: Change,
): Notification {
  return {
    kind: "change",
    source: { threadId, name: by, main: true },
    ...(actor && { actor }),
    ...(change && { change }),
    text,
    people: [],
    wake: false,
    ...(tray && { tray }),
  };
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

// Another agent's messages and reports come from the agent they name as their source.
const FROM_SOURCE: NotificationKind[] = ["message", "agent.ended", "agent.failed", "agent.stopped"];

export function actorOf(notification: Notification): NotificationActor | undefined {
  if (notification.actor) return notification.actor;
  if (!FROM_SOURCE.includes(notification.kind)) return undefined;
  const { threadId, name, main } = notification.source;
  return { kind: "agent", threadId, name, main };
}

export function createNotifier(options: NotifierOptions) {
  const { threads, runs, log, bus } = options;
  const mayStart = options.mayStart ?? (() => true);

  // Starts the thread's agent on the notifications waiting for it, when it is idle and may run.
  function startIfFree(threadId: string, append: Append) {
    if (runs.active(threadId)) return;
    const { inbox } = transcriptOf(threads.eventsAfter(threadId, 0).map(eventSummary));
    const waiting = waking(inbox);
    if (waiting.length === 0 || !mayStart(threadId)) return;
    startRun(
      runs,
      append,
      { threadId, triggerSeq: waiting[0]!.seq, createdBy: null },
      inbox.map((message) => message.id),
    );
  }

  return {
    // Leaves the notification in the thread, and starts its agent on it when it is idle.
    send(threadId: string, notification: Notification) {
      const actor = actorOf(notification);
      const { result } = log.write(threadId, (append) => {
        const stored = append({
          type: "notification",
          actor: { kind: "agent" },
          data: { ...notification, ...(actor && { actor }) },
        });
        if (notification.wake !== false) startIfFree(threadId, append);
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
