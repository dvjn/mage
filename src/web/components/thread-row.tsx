// One thread in a list of threads, in the sidebar or in a page's table, always two lines high
// whatever its status, so rows never move as threads start and stop working. The first line is its
// title, bold while something new waits there, and a slot at its end holding the status's glyph
// alone, or, while there is nothing new, how long ago the thread was last active, in a few
// characters. The second line is who has written in it, as a stack of avatars with the agent's
// last, then the start of its newest message with who wrote it, after where the thread is when it
// comes from another space. A page's row keeps a badge (its folder) and something about time (when
// it was last active, or when access ends) at the end of its first line; a sidebar row keeps the
// menu it is given, which takes the slot's place while the pointer is over the row. Every list of
// threads uses it, so they look and behave alike.

import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { BotIcon } from "lucide-react";
import type * as React from "react";

import type { ThreadStatus } from "@/shared/thread-status.ts";
import type { ThreadActivity, ThreadParticipants, ThreadPreview } from "@/shared/threads.ts";
import { StatusGlyph, useThreadStatus } from "@/web/components/thread-status";
import { ThreadTitle } from "@/web/components/thread-title";
import { ShortTime } from "@/web/components/time";
import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount } from "@/web/components/ui/avatar";
import { Badge } from "@/web/components/ui/badge";
import { SidebarMenuButton, SidebarMenuItem } from "@/web/components/ui/sidebar";
import { WithTooltip } from "@/web/components/with-tooltip";
import { initialsOf } from "@/web/lib/initials";

// The hover and focus of every row of a page's list.
export const ROW_CLASS =
  "rounded-md px-2 py-2.5 text-sm outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50";

const names = new Intl.ListFormat(undefined, { type: "conjunction" });

type Listed = {
  id: string;
  title: string;
  untitled: boolean;
  updatedAt: string;
  preview: ThreadPreview | null;
  participants: ThreadParticipants;
  activity: ThreadActivity;
};

interface RowProps {
  thread: Listed;
  // Where the thread is, for one from another space; starts the second line.
  place?: string;
}

type PageRowProps = RowProps & { badge?: string; time: React.ReactNode };

type SidebarRowProps = RowProps & {
  // What the row says in full, on hover.
  title?: string;
  isActive: boolean;
  // The row's menu and what it opens.
  children?: React.ReactNode;
};

export function ThreadRow(
  props: (PageRowProps & { variant?: "page" }) | (SidebarRowProps & { variant: "sidebar" }),
) {
  return props.variant === "sidebar" ? <SidebarRow {...props} /> : <PageRow {...props} />;
}

const avatarClass = "size-4.5 text-[0.5rem] font-semibold tracking-tight";

// Who has written in the thread, each as their initials, the agent as a bot, and how many more
// there are; all named on hover.
function Participants({ participants }: { participants: ThreadParticipants }) {
  const { people, total, agent } = participants;
  if (people.length === 0 && !agent) return null;
  const more = total - people.length;
  const label = names.format([
    ...people.map((person) => person.name),
    ...(more > 0 ? [`${more} more`] : []),
    ...(agent ? ["the agent"] : []),
  ]);
  return (
    <WithTooltip label={label}>
      <AvatarGroup role="img" aria-label={label} className="shrink-0 -space-x-1">
        {people.map((person) => (
          <Avatar key={person.userId} className={avatarClass}>
            <AvatarFallback className="text-[length:inherit]">
              {initialsOf(person.name)}
            </AvatarFallback>
          </Avatar>
        ))}
        {more > 0 && (
          <AvatarGroupCount className={cn(avatarClass, "tabular-nums")}>+{more}</AvatarGroupCount>
        )}
        {agent && (
          <Avatar className={avatarClass}>
            <AvatarFallback className="bg-primary/10 text-primary">
              <BotIcon className="size-2.5" />
            </AvatarFallback>
          </Avatar>
        )}
      </AvatarGroup>
    </WithTooltip>
  );
}

// The second line: who has written, then where the thread is and what was said last.
function Detail({ thread, place }: RowProps) {
  const preview = thread.preview && `${thread.preview.author}: ${thread.preview.text}`;
  return (
    <span className="flex h-4.5 min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <Participants participants={thread.participants} />
      <span className="truncate">
        {place}
        {place && preview && " · "}
        {preview}
      </span>
    </span>
  );
}

// The end of the first line: the status's glyph, or how long ago the thread was last active while
// there is nothing new.
function Slot({
  status,
  thread,
  className,
}: {
  status: ThreadStatus;
  thread: Listed;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "flex w-7 shrink-0 justify-end text-xs text-muted-foreground tabular-nums",
        className,
      )}
    >
      {status === "read" ? (
        <ShortTime iso={thread.updatedAt} />
      ) : (
        <StatusGlyph status={status} activity={thread.activity} />
      )}
    </span>
  );
}

function PageRow({ thread, place, badge, time }: PageRowProps) {
  const status = useThreadStatus(thread.activity);
  return (
    <Link
      to="/t/$threadId"
      params={{ threadId: thread.id }}
      data-status={status}
      className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 ${ROW_CLASS}`}
    >
      <ThreadTitle
        thread={thread}
        className={cn("h-5 truncate", status === "unread" ? "font-semibold" : "font-medium")}
      />
      <span className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
        <span className="flex w-4 shrink-0 justify-end">
          <StatusGlyph status={status} activity={thread.activity} />
        </span>
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
      <span className="col-span-2">
        <Detail thread={thread} place={place} />
      </span>
    </Link>
  );
}

// While the pointer is over a row with a menu, or the menu is in use, the menu stands where the
// slot is; on a phone the menu always shows, beside the slot.
const slotUnderMenu =
  "md:group-has-data-[sidebar=menu-action]/menu-item:group-hover/menu-item:opacity-0 md:group-has-[[data-sidebar=menu-action]:is(:focus-visible,[aria-expanded=true])]/menu-item:opacity-0";

function SidebarRow({ thread, place, title, isActive, children }: SidebarRowProps) {
  const status = useThreadStatus(thread.activity);
  const button = (
    <SidebarMenuButton
      size="lg"
      isActive={isActive}
      className="py-[5px] md:group-has-data-[sidebar=menu-action]/menu-item:pr-2"
      render={<Link to="/t/$threadId" params={{ threadId: thread.id }} />}
    >
      <span className="grid min-w-0 flex-1">
        <span className="flex h-5 min-w-0 items-center gap-2">
          <ThreadTitle
            thread={thread}
            className={cn("min-w-0 flex-1 truncate", status === "unread" && "font-medium")}
          />
          <Slot status={status} thread={thread} className={slotUnderMenu} />
        </span>
        <Detail thread={thread} place={place} />
      </span>
    </SidebarMenuButton>
  );
  return (
    <SidebarMenuItem data-status={status}>
      {title ? <WithTooltip label={title}>{button}</WithTooltip> : button}
      {children}
    </SidebarMenuItem>
  );
}
