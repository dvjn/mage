// One thread in a list of threads, in the sidebar or in a page's table, its height the same
// whatever its status, so rows never move as threads start and stop working. A page's row is two
// lines: a tile of its model leads, as its maker's mark with its host's badge on one corner, named
// with the model and its connection on hover, with the status's glyph on another corner; the first
// line is its title, bold while something new waits there, with a badge (its folder) and something
// about time (when it was last active, or when access ends) at its end; the second is who has
// written in it, as the first names of the one or two who wrote last and how many more, all named
// in full on hover with a guest marked, then where the thread is when the list mixes places. A
// sidebar row is one line: the status's glyph, or while there is none a small muted mark of its
// model's maker named with the model, the title, where the thread is when the list mixes places,
// and how long ago it was last active, under the menu it is given while the pointer is over the
// row. Every list of threads uses it, so they look and behave alike.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import type * as React from "react";

import type { ThreadStatus } from "@/shared/thread-status.ts";
import type { ShownModel, ThreadActivity, ThreadParticipants } from "@/shared/threads.ts";
import { MakerMark, ModelTile, modelLabel } from "@/web/models/marks";
import { StatusGlyph, useThreadStatus } from "@/web/threads/thread-status";
import { ThreadTitle } from "@/web/threads/thread-title";
import { ShortTime } from "@/web/components/time";
import { Badge } from "@/web/components/ui/badge";
import { SidebarMenuButton, SidebarMenuItem } from "@/web/components/ui/sidebar";
import { WithTooltip } from "@/web/components/with-tooltip";
import { meQuery } from "@/web/auth/queries";
import { writerLine, writersInFull } from "@/web/threads/writers";

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
// title first: the model's tile, named with the model and its connection, a bot for a model no one
// can tell the maker of or for none; and on its bottom-right corner the status's glyph, on a disc
// of the colour the row has, given as `disc`.
function RowTile({ thread, status, disc }: { thread: Listed; status: ThreadStatus; disc: string }) {
  const model = thread.shownModel;
  const label = model ? modelLabel(model.name, model.connection) : "No model";
  return (
    <ModelTile maker={model?.maker ?? null}>
      <WithTooltip label={label}>
        <span role="img" aria-label={label} className="absolute inset-0" />
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
    </ModelTile>
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
      <RowTile thread={thread} status={status} disc="bg-(--row)" />
    </Link>
  );
}

// While the pointer is over a sidebar row or header with a menu, or the menu is in use, the menu
// stands where this is; on a phone the menu always shows, beside it.
export const slotUnderMenu =
  "md:group-has-data-[sidebar=menu-action]/menu-item:group-hover/menu-item:opacity-0 md:group-has-[[data-sidebar=menu-action]:is(:focus-visible,[aria-expanded=true])]/menu-item:opacity-0";

// A row with a menu takes the full width, the menu standing over its end; on a phone the menu
// always shows, and the row keeps room for it.
export const menuRoom = "md:group-has-data-[sidebar=menu-action]/menu-item:pr-2";

// The start of a one-line row: the status's glyph, or while there is none a small muted mark of the
// model's maker, named with the model. First in the row, though after the title for screen
// readers, so a row is named by its title first.
export function RowLead({
  thread,
  status,
}: {
  thread: Pick<Listed, "shownModel" | "activity">;
  status: ThreadStatus;
}) {
  const model = thread.shownModel;
  const label = model ? modelLabel(model.name, model.connection) : "No model";
  return (
    <span className="order-first flex size-4 shrink-0 items-center justify-center">
      {status === "read" ? (
        <WithTooltip label={label}>
          <span role="img" aria-label={label} className="flex">
            <MakerMark
              maker={model?.maker ?? null}
              mono
              className="size-3.5 text-muted-foreground"
            />
          </span>
        </WithTooltip>
      ) : (
        <StatusGlyph status={status} activity={thread.activity} size="size-3.5" />
      )}
    </span>
  );
}

// The title of a one-line row, sized for the sidebar.
export const rowTitle = "min-w-0 flex-1 truncate text-[13px]";

function SidebarRow({ thread, place, title, isActive, children }: SidebarRowProps) {
  const status = useThreadStatus(thread.activity);
  const button = (
    <SidebarMenuButton
      isActive={isActive}
      className={menuRoom}
      render={<Link to="/t/$threadId" params={{ threadId: thread.id }} />}
    >
      <ThreadTitle thread={thread} className={cn(rowTitle, status === "unread" && "font-medium")} />
      {place && (
        <span title={place} className="max-w-16 shrink-0 truncate text-xs text-muted-foreground">
          {place}
        </span>
      )}
      <ShortTime
        iso={thread.updatedAt}
        className={cn("shrink-0 text-xs text-muted-foreground tabular-nums", slotUnderMenu)}
      />
      <RowLead thread={thread} status={status} />
    </SidebarMenuButton>
  );
  return (
    <SidebarMenuItem data-status={status}>
      {title ? <WithTooltip label={title}>{button}</WithTooltip> : button}
      {children}
    </SidebarMenuItem>
  );
}
