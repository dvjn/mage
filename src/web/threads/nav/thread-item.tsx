// A thread's row in the sidebar, with a menu to rename or delete it for those whose role allows
// it.

import { MoreHorizontalIcon, PencilIcon, Trash2Icon } from "lucide-react";
import type { ReactNode } from "react";

import type { ThreadListItem } from "@/shared/threads/list.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/web/components/ui/dropdown-menu";
import { SidebarMenuAction, useSidebar } from "@/web/components/ui/sidebar";
import { WithTooltip } from "@/web/components/with-tooltip";
import { useNav } from "@/web/threads/nav/nav-context";
import { ThreadRow } from "@/web/threads/thread-row";

function ItemMenu({ name, children }: { name: string; children: ReactNode }) {
  const { isMobile } = useSidebar();
  return (
    <DropdownMenu>
      <WithTooltip label="Actions">
        <DropdownMenuTrigger
          render={
            <SidebarMenuAction className="peer-hover/menu-button:opacity-100 hover:opacity-100 focus-visible:opacity-100 aria-expanded:bg-muted aria-expanded:opacity-100 md:opacity-0 peer-data-[size=lg]/menu-button:top-[5px]" />
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

export function ThreadItem({ thread }: { thread: ThreadListItem }) {
  const nav = useNav();
  return (
    <ThreadRow variant="sidebar" thread={thread} isActive={thread.id === nav.activeThreadId}>
      {nav.role !== "viewer" && (
        <ItemMenu name={thread.title}>
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
  );
}
