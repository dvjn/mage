// A glance at what a count or a name stands for: a card that opens on hover or focus where the
// device can hover, and on a tap otherwise. Its content mounts only while it is open, so what it
// shows is read then. A list in it scrolls, searches when long, and reads more as it is scrolled.

import { cn } from "cn";
import { SearchIcon } from "lucide-react";
import type * as React from "react";
import { useState } from "react";

import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/web/components/ui/hover-card";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/web/components/ui/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/web/components/ui/popover";
import { Skeleton } from "@/web/components/ui/skeleton";
import { useDebounced } from "@/web/hooks/use-debounced";
import { useCanHover } from "@/web/hooks/use-hover";
import { type PagesOptions, usePages } from "@/web/api/list-queries";

const triggerClass =
  "cursor-default rounded-sm text-left underline decoration-dotted decoration-muted-foreground/50 underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

export function Peek({
  label,
  trigger,
  className,
  children,
}: {
  // Names the trigger for those who cannot see it.
  label: string;
  trigger: React.ReactNode;
  className?: string;
  // Rendered only while open.
  children: () => React.ReactNode;
}) {
  const hover = useCanHover();
  const [open, setOpen] = useState(false);
  const button = (
    <button type="button" aria-label={label} className={cn(triggerClass, className)}>
      {trigger}
    </button>
  );
  if (hover) {
    return (
      <HoverCard open={open} onOpenChange={setOpen}>
        <HoverCardTrigger delay={250} render={button} />
        <HoverCardContent align="start" className="w-64 p-0">
          {open && children()}
        </HoverCardContent>
      </HoverCard>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={button} />
      <PopoverContent align="start" className="w-64 p-0">
        {open && children()}
      </PopoverContent>
    </Popover>
  );
}

// A list in a glance: a search when there are more than ten, then the rows, read a page at a time
// as the list scrolls to its end.
export function PeekList<T>({
  title,
  query,
  row,
  rowKey,
  empty,
}: {
  title: string;
  query: (q: string) => PagesOptions<T>;
  row: (item: T) => React.ReactNode;
  rowKey: (item: T) => string;
  empty: string;
}) {
  const [text, setText] = useState("");
  const q = useDebounced(text);
  const list = usePages(query(q));
  const total = list.total ?? 0;
  const searchable = total > 10 || !!q;
  return (
    <div className="flex flex-col">
      <div className="flex items-baseline justify-between gap-2 px-3 pt-2.5 pb-1.5">
        <span className="text-xs font-medium">{title}</span>
        {list.total !== undefined && (
          <span className="text-xs text-muted-foreground tabular-nums">{total}</span>
        )}
      </div>
      {searchable && (
        <div className="px-2 pb-1.5">
          <InputGroup className="h-7">
            <InputGroupInput
              aria-label={`Search ${title.toLowerCase()}`}
              placeholder="Search"
              value={text}
              onChange={(event) => setText(event.target.value)}
              className="text-xs"
            />
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
          </InputGroup>
        </div>
      )}
      <ul
        aria-label={title}
        className="max-h-64 overflow-y-auto px-1 pb-1"
        onScroll={(event) => {
          const el = event.currentTarget;
          if (
            el.scrollTop + el.clientHeight >= el.scrollHeight - 24 &&
            list.more &&
            !list.loading
          ) {
            list.loadMore();
          }
        }}
      >
        {list.pending &&
          Array.from({ length: 3 }, (_, index) => (
            <li key={index} className="px-2 py-1.5">
              <Skeleton className="h-4 w-full" />
            </li>
          ))}
        {list.items.map((item) => (
          <li key={rowKey(item)} className="rounded-md px-2 py-1.5 text-sm">
            {row(item)}
          </li>
        ))}
        {list.total !== undefined && list.items.length === 0 && (
          <li className="px-2 py-1.5 text-sm text-muted-foreground">{q ? "No matches" : empty}</li>
        )}
      </ul>
    </div>
  );
}
