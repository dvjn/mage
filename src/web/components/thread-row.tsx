// One thread in a page's list of threads: its title, a muted line after it (the start of its
// newest message, or where it is), a badge (its folder), and something about time (when it was last
// active, or when access ends). On a phone the muted line goes below. Every list of threads on a
// page uses it, so they look and behave alike.

import { Link } from "@tanstack/react-router";
import { MessageSquareIcon } from "lucide-react";
import type * as React from "react";

import { ThreadTitle } from "@/web/components/thread-title";
import { Badge } from "@/web/components/ui/badge";

// The hover and focus of every row of a page's list.
export const ROW_CLASS =
  "rounded-md px-2 py-2.5 text-sm outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50";

export function ThreadRow({
  thread,
  detail,
  badge,
  time,
}: {
  thread: { id: string; title: string; untitled: boolean };
  detail?: React.ReactNode;
  badge?: string;
  time: React.ReactNode;
}) {
  return (
    <li>
      <Link
        to="/t/$threadId"
        params={{ threadId: thread.id }}
        className={`grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 ${ROW_CLASS}`}
      >
        <MessageSquareIcon className="size-4 text-muted-foreground" />
        <span className="flex min-w-0 items-baseline gap-3">
          <ThreadTitle
            thread={thread}
            className="max-w-full shrink-0 truncate font-medium sm:max-w-[45%]"
          />
          {detail && (
            <span className="hidden min-w-0 flex-1 truncate text-muted-foreground sm:block">
              {detail}
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
        {detail && (
          <span className="col-span-2 col-start-2 truncate text-xs text-muted-foreground sm:hidden">
            {detail}
          </span>
        )}
      </Link>
    </li>
  );
}
