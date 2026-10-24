// One thread in a list of threads, in the sidebar or in a page's table, always two lines high
// whatever its status, so rows never move as threads start and stop working. A tile of its model
// leads the row, as its product's mark named with the model on hover, with the status's glyph on
// the tile's corner. The first line is its title, bold while something new waits there. The second
// line is who has written in it, as the first names of the one or two who wrote last and how many
// more, all named in full on hover with a guest marked, then where the thread is when the list
// mixes places. A sidebar row ends its second line with how long ago the thread was last active and
// keeps the menu it is given, which the title makes room for while the pointer is over the row. A
// page's row keeps a badge (its folder) and something about time (when it was last active, or when
// access ends) at the end of its first line. Every list of threads uses it, so they look and behave
// alike.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import type * as React from "react";

import type { ThreadStatus } from "@/shared/thread-status.ts";
import type { ShownModel, ThreadActivity, ThreadParticipants } from "@/shared/threads.ts";
import { ModelIcon } from "@/web/components/provider-icon";
import { StatusGlyph, useThreadStatus } from "@/web/components/thread-status";
import { ThreadTitle } from "@/web/components/thread-title";
import { ShortTime } from "@/web/components/time";
import { Badge } from "@/web/components/ui/badge";
import { SidebarMenuButton, SidebarMenuItem } from "@/web/components/ui/sidebar";
import { WithTooltip } from "@/web/components/with-tooltip";
import { meQuery } from "@/web/lib/queries";
import { writerLine, writersInFull } from "@/web/lib/writers";

// The hover and focus of every row of a page's list.
export const ROW_CLASS =
  "rounded-md px-2 py-2.5 text-sm outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50";

type Listed = {
  id: string;
  title: string;
  untitled: boolean;
  updatedAt: string;
  shownModel: ShownModel | null;
  participants: ThreadParticipants;
  activity: ThreadActivity;
};

interface RowProps {
  thread: Listed;
  // Where the thread is, for a list that mixes places; after the names on the second line.
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

// The tile leading the row, though after the title for screen readers, so a row is named by its
// title first: the model's mark, named with the model, a bot for a model of no
// provider Mage knows or for none; and on its corner the status's glyph, on a disc of the colour
// the row has, given as `disc`.
function ModelTile({
  thread,
  status,
  disc,
}: {
  thread: Listed;
  status: ThreadStatus;
  disc: string;
}) {
  const model = thread.shownModel;
  const label = model?.name ?? "No model";
  return (
    <span className="relative order-first grid size-8 shrink-0 place-items-center overflow-visible! rounded-lg bg-muted">
      <WithTooltip label={label}>
        <span role="img" aria-label={label} className="flex">
          <ModelIcon provider={model?.provider ?? null} className="size-4" />
        </span>
      </WithTooltip>
      <StatusGlyph
        status={status}
        activity={thread.activity}
        size="size-3"
        className={cn(
          "absolute -right-1.5 -bottom-1.5 grid size-5 place-items-center rounded-full",
          disc,
        )}
      />
    </span>
  );
}

// Who has written, by first name, "You" for whoever is signed in, then where the thread is, which
// gives way first when the line is short of room.
function Writers({ thread, place }: RowProps) {
  const me = useQuery(meQuery);
  const line = writerLine(thread.participants, me.data?.user.id);
  const full = writersInFull(thread.participants);
  return (
    <>
      {line && full ? (
        <WithTooltip label={full}>
          <span className="max-w-full shrink-0 truncate">{line}</span>
        </WithTooltip>
      ) : (
        <span className="min-w-0 truncate">No messages yet</span>
      )}
      {place && (
        <>
          <span aria-hidden>·</span>
          <span className="min-w-0 truncate">{place}</span>
        </>
      )}
    </>
  );
}

// The colour a page's row has, for the disc under the status: the page's, or under the pointer,
// its own tint over its table row's.
const pageRowColour =
  "[--row:var(--background)] hover:[--row:color-mix(in_oklab,var(--muted)_75%,var(--background))]";

function PageRow({ thread, place, badge, time }: PageRowProps) {
  const status = useThreadStatus(thread.activity);
  return (
    <Link
      to="/t/$threadId"
      params={{ threadId: thread.id }}
      data-status={status}
      className={`flex items-center gap-3 ${ROW_CLASS} ${pageRowColour}`}
    >
      <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3">
        <ThreadTitle
          thread={thread}
          className={cn("h-5 truncate", status === "unread" ? "font-semibold" : "font-medium")}
        />
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
        <span className="col-span-2 flex h-4.5 min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <Writers thread={thread} place={place} />
        </span>
      </span>
      <ModelTile thread={thread} status={status} disc="bg-(--row)" />
    </Link>
  );
}

// The disc under the status takes the sidebar's colour, or the row's while it is under the pointer
// or open.
const sidebarDisc =
  "bg-sidebar group-hover/menu-button:bg-sidebar-accent group-data-active/menu-button:bg-sidebar-accent";

// The row keeps room for its menu only while the pointer is over it, or the menu is in use, so the
// title has the full width otherwise; on a phone the menu always shows, and the room stays.
const menuRoom =
  "md:group-has-data-[sidebar=menu-action]/menu-item:pr-2 md:group-has-data-[sidebar=menu-action]/menu-item:group-hover/menu-item:pr-8 md:group-has-[[data-sidebar=menu-action]:is(:focus-visible,[aria-expanded=true])]/menu-item:pr-8";

function SidebarRow({ thread, place, title, isActive, children }: SidebarRowProps) {
  const status = useThreadStatus(thread.activity);
  const button = (
    <SidebarMenuButton
      size="lg"
      isActive={isActive}
      className={cn("gap-2.5 py-1.5", menuRoom)}
      render={<Link to="/t/$threadId" params={{ threadId: thread.id }} />}
    >
      <span className="grid min-w-0 flex-1 grid-cols-1">
        <ThreadTitle
          thread={thread}
          className={cn("h-5 truncate", status === "unread" && "font-medium")}
        />
        <span className="flex h-4 min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <Writers thread={thread} place={place} />
          <ShortTime iso={thread.updatedAt} className="ml-auto shrink-0 pl-1 tabular-nums" />
        </span>
      </span>
      <ModelTile thread={thread} status={status} disc={sidebarDisc} />
    </SidebarMenuButton>
  );
  return (
    <SidebarMenuItem data-status={status}>
      {title ? <WithTooltip label={title}>{button}</WithTooltip> : button}
      {children}
    </SidebarMenuItem>
  );
}
