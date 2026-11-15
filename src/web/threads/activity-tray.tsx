// The thread's activity tray: a strip of icons on top of the one surface it shares with the
// composer, one for each kind of what is live in it, that opens that kind's cards. The chat records
// what happened; the tray shows what is live, so nothing is shown in full in both. A kind shows
// with something in it, with its count, tinted by its most urgent state, open or not; the strip is
// not there with nothing. A kind opens its cards between the strip and the input, one at a time,
// scrolling inside; closing a kind marks it seen, and what ended in it then leaves.

import { cn } from "cn";
import {
  BotIcon,
  CalendarClockIcon,
  HandIcon,
  ListChecksIcon,
  WebhookIcon,
  WrenchIcon,
} from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";

import { useQuery } from "@tanstack/react-query";

import type { ToolScope } from "@/shared/threads/events.ts";
import { type Attention, type ActivityItem, type TrayKind, trayKindOf } from "@/shared/jobs.ts";
import { Button } from "@/web/components/ui/button";
import { WithTooltip } from "@/web/components/with-tooltip";
import { useIsMobile } from "@/web/hooks/use-mobile";
import { TrayList } from "@/web/threads/tray-cards";
import { useSeenActivity } from "@/web/threads/mutations";
import { activityQuery, tasksQuery } from "@/web/threads/queries";
import { PagerControl, PagerSlotContext, type PagerState } from "@/web/threads/pager";
import { TaskActions, TaskList } from "@/web/threads/task-list";

export type TrayGroup = "tasks" | TrayKind;
type Group = TrayGroup;

// Opens a kind's cards, from a row of the transcript that stands for one of its items.
export const OpenTrayContext = createContext<(group: TrayGroup) => void>(() => {});

export function useOpenTray() {
  return useContext(OpenTrayContext);
}

// The kinds in the strip's order, each with what it is called and shown with.
const GROUPS: { id: Group; label: string; icon: ReactNode }[] = [
  { id: "approvals", label: "Approvals", icon: <HandIcon /> },
  { id: "tasks", label: "Tasks", icon: <ListChecksIcon /> },
  { id: "jobs", label: "Background jobs", icon: <WrenchIcon /> },
  { id: "subagents", label: "Subagents", icon: <BotIcon /> },
  { id: "schedules", label: "Schedules", icon: <CalendarClockIcon /> },
  { id: "webhooks", label: "Webhooks", icon: <WebhookIcon /> },
];

const WORDS: Record<Attention, string> = {
  approval: "needs you",
  failed: "failed",
  soon: "fires soon",
};

// What tints a kind's icon: its most urgent state, which the tooltip says in words; muted when
// nothing under it asks for anyone or runs. A status colour holds through hover, focus, pressed and
// open; only the background changes. Class names are spelled out so Tailwind finds them.
const PINNED = {
  destructive:
    "text-destructive hover:text-destructive focus-visible:text-destructive aria-pressed:text-destructive aria-expanded:text-destructive",
  warning:
    "text-warning hover:text-warning focus-visible:text-warning aria-pressed:text-warning aria-expanded:text-warning",
  info: "text-info hover:text-info focus-visible:text-info aria-pressed:text-info aria-expanded:text-info",
};

function tint(reason: Attention | undefined, running: boolean) {
  if (reason === "failed") return PINNED.destructive;
  if (reason) return PINNED.warning;
  return running ? PINNED.info : "text-muted-foreground";
}

// The most pressing reason among items: an approval, then a failure, then something about to fire.
function pressing(items: ActivityItem[]) {
  return (["approval", "failed", "soon"] as const).find((reason) =>
    items.some((item) => item.attention === reason),
  );
}

export function ActivityTray({
  threadId,
  agentName,
  asked,
  onAsk,
  decide,
  onHold,
  settled,
  children,
}: {
  // The rest of the surface: the composer, or what stands in its place.
  children: ReactNode;
  // Whether the thread has loaded; the strip waits for it.
  settled: boolean;
  threadId: string;
  agentName: string;
  // Decides a call waiting for approval, as the page does from its row.
  decide: (callId: string, allow: boolean, scope: ToolScope) => Promise<void>;
  // Tells the page which rows have their cards open, to keep them marked.
  onHold: (rowIds: ReadonlySet<string>) => void;
  // The kind opened, held by the page so that rows of the transcript can open one too.
  asked: TrayGroup | null;
  onAsk: (group: TrayGroup | null) => void;
}) {
  const taskList = useQuery(tasksQuery(threadId)).data;
  // In a subagent's thread that uses its starter's list, only the tasks given to it count.
  const tasks = (taskList?.tasks ?? []).filter(
    (task) =>
      !taskList?.shared ||
      (task.assignee?.kind === "subagent" && task.assignee.threadId === threadId),
  );
  const items = useQuery(activityQuery(threadId)).data?.items ?? [];
  const seen = useSeenActivity(threadId);
  const mobile = useIsMobile();
  const kinds = GROUPS.map((group) => {
    const own =
      group.id === "tasks" ? [] : items.filter((item) => trayKindOf(item.work) === group.id);
    const count = group.id === "tasks" ? tasks.length : own.length;
    const done = tasks.filter((task) => task.status === "done").length;
    const reason = pressing(own);
    const running = own.some(
      (item) => item.work.status === "running" || item.work.subagent?.state === "working",
    );
    return {
      running,
      ...group,
      own,
      count,
      text: group.id === "tasks" ? `${done}/${tasks.length}` : `${count}`,
      reason,
      title: reason ? `${group.label} · ${WORDS[reason]}` : group.label,
    };
  }).filter((group) => settled && group.count > 0);
  // A kind that has nothing left is closed.
  const open = kinds.find((group) => group.id === asked) ?? null;

  const choose = onAsk;
  // A call that starts waiting for a decision this reader may make opens the approvals, once: not
  // again after they close it. Another kind open stays, unless the reader is not using its panel;
  // its icon is amber already. Nothing here takes focus.
  const decidable = items
    .filter((item) => trayKindOf(item.work) === "approvals" && item.work.canDecide)
    .map((item) => item.rowId);
  const decidableKey = decidable.join("\n");
  const told = useRef(new Set<string>());
  useEffect(() => {
    if (!settled) return;
    const now = new Set(decidableKey ? decidableKey.split("\n") : []);
    const fresh = [...now].some((id) => !told.current.has(id));
    told.current = now;
    if (!fresh || asked === "approvals") return;
    const panel = tray.current;
    const using = !!panel && (panel.contains(document.activeElement) || panel.matches(":hover"));
    if (asked === null || !using) choose("approvals");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decidableKey, settled]);
  // The rows of the cards that are open stay marked in the transcript.
  const heldKey = open && open.id !== "tasks" ? open.own.map((item) => item.rowId).join("\n") : "";
  useEffect(() => {
    onHold(new Set(heldKey ? heldKey.split("\n") : []));
    return () => onHold(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heldKey]);
  const tray = useRef<HTMLDivElement>(null);
  const openId = open?.id ?? null;
  // Whether the tasks card shows the archived tasks; opening it again shows the current ones.
  const [archivedTasks, setArchivedTasks] = useState(false);
  const [addingTask, setAddingTask] = useState(false);
  // The open list's pager, shown in the header.
  const [pager, setPager] = useState<PagerState | null>(null);
  useEffect(() => {
    setArchivedTasks(false);
    setAddingTask(false);
  }, [openId]);

  // A click outside the strip and its panel closes it, as does Esc; what floats above the
  // panel (menus, dialogs) is not outside.
  useEffect(() => {
    if (!openId) return;
    const press = (event: PointerEvent) => {
      const target = event.target;
      // The path as dispatched: a button inside may replace itself on the press, and then no longer
      // be in it.
      if (
        !(target instanceof Element) ||
        (tray.current && event.composedPath().includes(tray.current))
      ) {
        return;
      }
      if (
        target.closest(
          '[data-slot$="-content"], [data-slot$="-overlay"], [role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"]',
        )
      ) {
        return;
      }
      choose(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) choose(null);
    };
    document.addEventListener("pointerdown", press);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", press);
      document.removeEventListener("keydown", key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);

  // Having seen a kind is having opened it and then closed it, or turned to another.
  const was = useRef<Group | null>(null);
  useEffect(() => {
    const before = was.current;
    was.current = openId;
    if (before && before !== openId && before !== "tasks" && before !== "approvals") {
      seen.mutate(before);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);

  const cards = open && (
    <>
      {open.id === "tasks" ? (
        <TaskList
          threadId={threadId}
          agentName={agentName}
          archived={archivedTasks}
          adding={addingTask}
          onAddingChange={setAddingTask}
        />
      ) : (
        <TrayList
          key={open.id}
          items={open.own}
          threadId={threadId}
          decide={decide}
          onReview={() => choose("approvals")}
        />
      )}
    </>
  );
  return (
    <div
      className="flex flex-col divide-y rounded-lg surface-floating has-[[data-tray-strip]]:**:data-[slot=input-group]:rounded-t-none has-[[data-tray-strip]]:**:data-[slot=input-group]:border-0 has-[[data-tray-strip]]:**:data-[slot=input-group]:bg-transparent!"
      data-testid="dock"
    >
      {kinds.length > 0 && (
        <div ref={tray} data-tray-strip className="flex min-w-0 flex-col divide-y">
          {open && (
            <section
              aria-label={open.label}
              className="flex max-h-[min(18rem,50dvh)] min-h-0 flex-col"
            >
              <header className="flex h-9 shrink-0 items-center justify-between gap-0.5 px-3">
                <h3 className="font-medium">{open.label}</h3>
                <div className="flex items-center">
                  {pager && <PagerControl {...pager} />}
                  {open.id === "tasks" && (
                    <TaskActions
                      threadId={threadId}
                      archived={archivedTasks}
                      onArchived={setArchivedTasks}
                      onAdd={() => setAddingTask(true)}
                    />
                  )}
                </div>
              </header>
              <div
                className="flex min-h-0 flex-1 flex-col overflow-y-auto border-t overscroll-contain px-1.5 py-1.5"
                data-testid="tray-cards"
                // A link out of the panel leaves the chat uncovered on a phone.
                onClickCapture={(event) => {
                  if (mobile && (event.target as Element).closest("a")) choose(null);
                }}
              >
                <PagerSlotContext.Provider value={setPager}>{cards}</PagerSlotContext.Provider>
              </div>
            </section>
          )}
          <div className="flex items-center gap-0.5 p-1" role="toolbar" aria-label="Context">
            {kinds.map((group) => (
              <WithTooltip key={group.id} label={group.title}>
                <Button
                  type="button"
                  size="sm"
                  variant={open?.id === group.id ? "secondary" : "ghost"}
                  aria-label={group.label}
                  aria-pressed={open?.id === group.id}
                  data-kind={group.id}
                  data-attention={group.reason}
                  className={cn("min-w-7 justify-center px-1.5", tint(group.reason, group.running))}
                  onClick={() => choose(open?.id === group.id ? null : group.id)}
                >
                  {group.icon}
                  {group.text && <span className="tabular-nums">{group.text}</span>}
                </Button>
              </WithTooltip>
            ))}
          </div>
        </div>
      )}
      {children}
    </div>
  );
}
