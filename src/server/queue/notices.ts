// Notices: what a thread's agent is told from outside its thread, by other agents, of the work it
// started, or of what people changed, each with where it came from and everyone whose words it
// carries.

import type {
  Change,
  NoticeActor,
  NoticeKind,
  NoticeParts,
  NoticeSource,
  Influencer,
  SubagentTask,
} from "@/shared/threads/events.ts";

export interface Notice extends NoticeParts {
  kind: NoticeKind;
  source: NoticeSource;
  // Who it is shown as coming from; for an agent's message or report, the agent it came from.
  actor?: NoticeActor;
  text: string;
  influence: Influencer[];
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
  tray?: NoticeParts["tray"],
  actor?: NoticeActor,
  change?: Change,
): Notice {
  return {
    kind: "change",
    source: { threadId, name: by, main: true },
    ...(actor && { actor }),
    ...(change && { change }),
    text,
    influence: [],
    wake: false,
    ...(tray && { tray }),
  };
}

// That the agent reads its space's tools and instructions again, as asked by the person.
export function reloadNotice(threadId: string, by?: { userId: string; name: string }): Notice {
  return {
    kind: "reload",
    source: { threadId, name: by?.name ?? "System", main: true },
    ...(by && { actor: { kind: "person" as const, ...by } }),
    text: by
      ? `${by.name} reloaded the agent's tools and instructions`
      : "The agent's tools and instructions were reloaded",
    influence: [],
    wake: false,
  };
}

// Another agent's messages and reports come from the agent they name as their source.
const FROM_SOURCE: NoticeKind[] = ["message", "agent.ended", "agent.failed", "agent.stopped"];

export function actorOf(notice: Notice): NoticeActor | undefined {
  if (notice.actor) return notice.actor;
  if (!FROM_SOURCE.includes(notice.kind)) return undefined;
  const { threadId, name, main } = notice.source;
  return { kind: "agent", threadId, name, main };
}
