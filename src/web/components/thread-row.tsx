// One thread in a list of threads, in the sidebar or in a page's table: its status for the signed-in person
// in the icon slot, its title, bold while something new waits there, and a muted line that starts
// with what the status says, then the start of its newest message or where it is. A page's row
// also has a badge (its folder) and something about time (when it was last active, or when access
// ends); on a phone its muted line goes below. A sidebar row is one line while its thread holds
// nothing to say beyond new or not, and two otherwise or when it is shared; it keeps the menu it is
// given. Every list of threads uses it, so they look and behave alike.

import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import type * as React from "react";

import type { ThreadActivity } from "@/shared/threads.ts";
import { StatusGlyph, statusLabel, useThreadStatus } from "@/web/components/thread-status";
import { ThreadTitle } from "@/web/components/thread-title";
import { Badge } from "@/web/components/ui/badge";
import { SidebarMenuButton, SidebarMenuItem } from "@/web/components/ui/sidebar";
import { WithTooltip } from "@/web/components/with-tooltip";

// The hover and focus of every row of a page's list.
export const ROW_CLASS =
  "rounded-md px-2 py-2.5 text-sm outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50";

interface RowProps {
  thread: { id: string; title: string; untitled: boolean; activity: ThreadActivity };
  // What follows the status in the muted line: the newest message, or where the thread is.
  detail?: React.ReactNode;
}

// The status's label, then the detail, joined by a dot.
function Secondary({ label, detail }: { label: string | null; detail?: React.ReactNode }) {
  return (
    <>
      {label && <span className="text-foreground">{label}</span>}
      {label && detail && " · "}
      {detail}
    </>
  );
}

type PageRowProps = RowProps & { badge?: string; time: React.ReactNode };

type SidebarRowProps = RowProps & {
  // What the row says in full, on hover.
  title?: string;
  // Shared threads always show where they are.
  shared?: boolean;
  isActive: boolean;
  // The row's menu and what it opens.
  children?: React.ReactNode;
};

export function ThreadRow(
  props: (PageRowProps & { variant?: "page" }) | (SidebarRowProps & { variant: "sidebar" }),
) {
  return props.variant === "sidebar" ? <SidebarRow {...props} /> : <PageRow {...props} />;
}

function PageRow({ thread, detail, badge, time }: PageRowProps) {
  const status = useThreadStatus(thread.activity);
  const label = statusLabel(status, thread.activity);
  const secondary = (label || detail) && <Secondary label={label} detail={detail} />;
  return (
    <Link
      to="/t/$threadId"
      params={{ threadId: thread.id }}
      data-status={status}
      className={`grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 ${ROW_CLASS}`}
    >
      <StatusGlyph status={status} activity={thread.activity} />
      <span className="flex min-w-0 items-baseline gap-3">
        <ThreadTitle
          thread={thread}
          className={cn(
            "max-w-full shrink-0 truncate sm:max-w-[45%]",
            status === "unread" ? "font-semibold" : "font-medium",
          )}
        />
        {secondary && (
          <span className="hidden min-w-0 flex-1 truncate text-muted-foreground sm:block">
            {secondary}
          </span>
        )}
      </span>
      <span className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
        {badge && (
          <Badge
            variant="outline"
            className="hidden font-normal text-muted-foreground sm:inline-flex"
          >
            {badge}
          </Badge>
        )}
        {time}
      </span>
      {secondary && (
        <span className="col-span-2 col-start-2 truncate text-xs text-muted-foreground sm:hidden">
          {secondary}
        </span>
      )}
    </Link>
  );
}

function SidebarRow({
  thread,
  detail,
  title,
  shared = false,
  isActive,
  children,
}: SidebarRowProps) {
  const status = useThreadStatus(thread.activity);
  const label = statusLabel(status, thread.activity);
  const twoLines = shared || (status !== "read" && status !== "unread");
  const button = (
    <SidebarMenuButton
      size={twoLines ? "lg" : "default"}
      isActive={isActive}
      render={<Link to="/t/$threadId" params={{ threadId: thread.id }} />}
    >
      <StatusGlyph status={status} activity={thread.activity} />
      {twoLines ? (
        <span className="grid min-w-0 leading-tight">
          <ThreadTitle
            thread={thread}
            className={cn("truncate", status === "unread" && "font-medium")}
          />
          <span className="truncate text-xs text-muted-foreground">
            <Secondary label={label} detail={detail} />
          </span>
        </span>
      ) : (
        <ThreadTitle thread={thread} className={cn(status === "unread" && "font-medium")} />
      )}
    </SidebarMenuButton>
  );
  return (
    <SidebarMenuItem data-status={status}>
      {title ? <WithTooltip label={title}>{button}</WithTooltip> : button}
      {children}
    </SidebarMenuItem>
  );
}
