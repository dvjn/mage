// A thread's row in the sidebar, with a menu to rename or delete it for those whose role allows
// it. A thread whose agent started subagents has a caret on its row that shows them beneath it as
// rows of their own: open once one of them works, waits or is open, and folded otherwise, until the
// person chooses; retired subagents stay out of the list, reached from the thread.

import { cn } from "cn";
import { ChevronRightIcon, MoreHorizontalIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { type ReactNode, useReducer } from "react";

import type { ListedSubagent, ThreadListItem } from "@/shared/threads/list.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/web/components/ui/dropdown-menu";
import { SidebarMenuAction, SidebarMenuSub, useSidebar } from "@/web/components/ui/sidebar";
import { WithTooltip } from "@/web/components/with-tooltip";
import { useNav } from "@/web/threads/nav/nav-context";
import { ThreadRow } from "@/web/threads/thread-row";

// The room a row with a caret keeps at its end: for the caret, and beside it the menu, which on a
// phone always shows.
const CARET_ROOM =
  "pr-7 group-has-data-[sidebar=menu-action]/menu-item:pr-13 md:group-has-data-[sidebar=menu-action]/menu-item:pr-7";

function ItemMenu({
  name,
  besideCaret,
  children,
}: {
  name: string;
  besideCaret: boolean;
  children: ReactNode;
}) {
  const { isMobile } = useSidebar();
  return (
    <DropdownMenu>
      <WithTooltip label="Actions">
        <DropdownMenuTrigger
          render={
            <SidebarMenuAction
              className={cn(
                "peer-hover/menu-button:opacity-100 hover:opacity-100 focus-visible:opacity-100 aria-expanded:bg-muted aria-expanded:opacity-100 md:opacity-0 peer-data-[size=lg]/menu-button:top-[5px]",
                besideCaret && "right-7",
              )}
            />
          }
        >
          <MoreHorizontalIcon />
          <span className="sr-only">Actions for {name}</span>
        </DropdownMenuTrigger>
      </WithTooltip>
      <DropdownMenuContent
        className="w-48"
        side={isMobile ? "bottom" : "right"}
        align={isMobile ? "end" : "start"}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Whether each thread's subagents show, as the person chose, and the threads whose subagents opened
// once one of them worked; they stay open as their subagents finish, so none leaves from under the
// pointer. Kept apart from the rows, which move between groups as their status changes.
const chosenSubagents = new Map<string, boolean>();
const openedSubagents = new Set<string>();

// A subagent as its thread's row shows it.
function subagentRow(subagent: ListedSubagent) {
  return { ...subagent, id: subagent.threadId };
}

export function ThreadItem({ thread }: { thread: ThreadListItem }) {
  const nav = useNav();
  const subagents = (thread.subagents ?? []).filter((subagent) => subagent.state !== "archived");
  const busy = subagents.some(
    (subagent) =>
      subagent.state === "working" ||
      subagent.state === "queued" ||
      subagent.threadId === nav.activeThreadId,
  );
  const [, shown] = useReducer((count: number) => count + 1, 0);
  const chosen = chosenSubagents.get(thread.id);
  if (busy) openedSubagents.add(thread.id);
  const open = subagents.length > 0 && (chosen ?? openedSubagents.has(thread.id));
  return (
    <>
      <ThreadRow
        variant="sidebar"
        thread={thread}
        isActive={thread.id === nav.activeThreadId}
        room={subagents.length > 0 ? CARET_ROOM : undefined}
      >
        {subagents.length > 0 && (
          <button
            type="button"
            aria-label="Subagents"
            aria-expanded={open}
            onClick={() => {
              chosenSubagents.set(thread.id, !open);
              shown();
            }}
            className="absolute top-1.5 right-1 flex size-5 items-center justify-center rounded-md text-muted-foreground outline-hidden group-data-[collapsible=icon]:hidden hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          >
            <ChevronRightIcon
              className={cn("size-3.5 transition-transform", open && "rotate-90")}
            />
          </button>
        )}
        {nav.role !== "viewer" && (
          <ItemMenu name={thread.title} besideCaret={subagents.length > 0}>
            <DropdownMenuItem onClick={() => nav.act({ kind: "rename-thread", thread })}>
              <PencilIcon />
              Rename
            </DropdownMenuItem>
            {nav.role === "owner" && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => nav.act({ kind: "delete-thread", thread })}
                >
                  <Trash2Icon />
                  Delete
                </DropdownMenuItem>
              </>
            )}
          </ItemMenu>
        )}
      </ThreadRow>
      {open && (
        <li aria-label={`Subagents of ${thread.title}`}>
          <SidebarMenuSub className="mr-0 gap-0 py-0 pr-0">
            {subagents.map((subagent) => (
              <ThreadRow
                key={subagent.threadId}
                variant="sidebar"
                thread={subagentRow(subagent)}
                isActive={subagent.threadId === nav.activeThreadId}
              />
            ))}
          </SidebarMenuSub>
        </li>
      )}
    </>
  );
}
