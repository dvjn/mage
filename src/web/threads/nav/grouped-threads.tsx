// The sidebar's threads, grouped: those that wait on the person or failed since they looked, those
// the agent works on, those with something new, all of them; then the few most recent of today and
// of the previous 7 days. A last row leads to the search for those left out. Rows stay where they
// are while the pointer is over the list.

import { SearchIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { ThreadStatus } from "@/shared/thread-status.ts";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/web/components/ui/sidebar";
import { groupOf, type ThreadGroup } from "@/web/threads/thread-groups";

// The most threads of today, and of the previous 7 days, listed; older ones never are.
const RECENT_LIMIT = 4;

const LIMITS: Partial<Record<ThreadGroup, number>> = {
  Today: RECENT_LIMIT,
  "Previous 7 days": RECENT_LIMIT,
  Older: 0,
};

type Grouped = { id: string; updatedAt: string; status: ThreadStatus };

// Where each thread sits in the list: its group and place in it.
type Layout = Map<string, { group: ThreadGroup; index: number }>;

function layoutOf(threads: Grouped[], now: Date): Layout {
  return new Map(
    threads.map((thread, index) => [
      thread.id,
      {
        group: groupOf(thread.status, thread.updatedAt, now),
        index,
      },
    ]),
  );
}

// The threads by group, in the layout given, threads it does not know yet first in their own
// group; each with how many it holds and the few it lists.
function grouping<T extends Grouped>(threads: T[], layout: Layout, fresh: Layout) {
  const placed = threads
    .map((thread) => ({
      thread,
      at: layout.get(thread.id) ?? { ...fresh.get(thread.id)!, index: -1 },
    }))
    .toSorted((a, b) => a.at.index - b.at.index);
  const groups = (["Needs you", "Working", "Unread", "Today", "Previous 7 days"] as const).map(
    (group) => {
      const all = placed.filter((p) => p.at.group === group).map((p) => p.thread);
      return { group, list: all.slice(0, LIMITS[group] ?? all.length) };
    },
  );
  return groups.filter((g) => g.list.length > 0);
}

// The threads grouped, the pointer holding them in place, with a last row for those left out.
export function GroupedThreads<T extends Grouped>({
  threads,
  total,
  row,
  more,
  onMore,
  children,
}: {
  threads: T[];
  // How many threads there are in all, listed or not.
  total: number;
  row: (thread: T) => ReactNode;
  more: (hidden: number) => string;
  onMore: () => void;
  // What the list says while it is read or empty.
  children?: ReactNode;
}) {
  // The layout while the pointer is over the list, so rows do not move under it.
  const [held, setHeld] = useState<Layout | null>(null);
  const now = new Date();
  const fresh = layoutOf(threads, now);
  const groups = grouping(threads, held ?? fresh, fresh);
  const shown = groups.reduce((sum, g) => sum + g.list.length, 0);
  const hidden = Math.max(total, threads.length) - shown;
  return (
    <SidebarMenu
      onPointerEnter={() => setHeld(layoutOf(threads, now))}
      onPointerLeave={() => setHeld(null)}
    >
      {groups.map(({ group, list }) => (
        <li key={group} className="contents">
          <span aria-hidden className="px-2 pt-3 pb-1 text-xs text-muted-foreground">
            {group}
          </span>
          <ul className="flex flex-col gap-0.5" aria-label={group}>
            {list.map(row)}
          </ul>
        </li>
      ))}
      {hidden > 0 && (
        <SidebarMenuItem>
          <SidebarMenuButton className="text-muted-foreground" onClick={onMore}>
            <SearchIcon />
            <span>{more(hidden)}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      )}
      {children}
    </SidebarMenu>
  );
}
