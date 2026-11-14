// Notices: what a thread's agent is told from outside its thread, by other agents, of the work it
// started, or of what people changed, each with where it came from and everyone whose words it
// carries.

import type {
  Change,
  NotificationActor,
  NotificationKind,
  NotificationParts,
  NotificationSource,
  Steering,
  SubagentTask,
} from "@/shared/threads/events.ts";

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

// Another agent's messages and reports come from the agent they name as their source.
const FROM_SOURCE: NotificationKind[] = ["message", "agent.ended", "agent.failed", "agent.stopped"];

export function actorOf(notification: Notification): NotificationActor | undefined {
  if (notification.actor) return notification.actor;
  if (!FROM_SOURCE.includes(notification.kind)) return undefined;
  const { threadId, name, main } = notification.source;
  return { kind: "agent", threadId, name, main };
}
