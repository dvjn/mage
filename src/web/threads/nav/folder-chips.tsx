// The sidebar's folder chips: all of the space first, then the few most recently active folders,
// each with how many threads it holds and a dot while one inside needs the person, then one that
// leads to the rest in the search. The picked folder's menu starts a thread in it, renames or
// deletes it.

import { cn } from "cn";
import { MoreHorizontalIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/web/components/ui/dropdown-menu";
import { WithTooltip } from "@/web/components/with-tooltip";
import type { FolderActivity } from "@/web/folders/folder-activity";
import { useNav } from "@/web/threads/nav/nav-context";
import { useOpenThreadSearch } from "@/web/threads/thread-search";
import { NeedsYouDot } from "@/web/threads/thread-status";

// How many folders have a chip of their own.
const FOLDER_CHIPS = 4;

function Chip({
  pressed,
  onClick,
  dashed,
  tooltip,
  children,
}: {
  pressed?: boolean;
  onClick: () => void;
  dashed?: boolean;
  // The name in full, for one that may be cut short.
  tooltip?: string;
  children: ReactNode;
}) {
  const chip = (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "inline-flex h-6 max-w-full items-center gap-1.5 rounded-full border px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        pressed
          ? "border-foreground bg-foreground text-background"
          : "border-sidebar-border text-sidebar-foreground hover:bg-sidebar-accent",
        dashed && "border-dashed text-muted-foreground",
      )}
    >
      {children}
    </button>
  );
  return tooltip ? <WithTooltip label={tooltip}>{chip}</WithTooltip> : chip;
}

function ChipCount({ count, pressed }: { count: number; pressed: boolean }) {
  return (
    <span className={cn("tabular-nums", pressed ? "opacity-60" : "text-muted-foreground")}>
      {/* The space parts it from the name for screen readers; a chip's edge hides it. */}
      {` ${count}`}
      <span className="sr-only">{count === 1 ? " thread" : " threads"}</span>
    </span>
  );
}

// All of the space, the most recently active folders and the one picked, as many as fit on two
// rows, the rest in the search, and the picked folder's menu.
export function FolderChips({
  folders,
  total,
  picked,
  onPick,
  onStart,
}: {
  folders: FolderActivity[];
  total: number;
  picked: FolderActivity | undefined;
  onPick: (folderId: string | null) => void;
  onStart: (folderId: string) => void;
}) {
  const nav = useNav();
  const openSearch = useOpenThreadSearch();
  const ref = useRef<HTMLDivElement>(null);
  // How many folders have a chip, fewer while the chips take more than two rows.
  const [fit, setFit] = useState(FOLDER_CHIPS);
  const [width, setWidth] = useState(0);
  const chips = folders.slice(0, fit);
  if (picked && !chips.includes(picked)) chips.push(picked);
  const hidden = folders.length - chips.length;
  // Measured again from the most whenever what they show or the room for them changes.
  const shape = `${width}|${picked?.folder.id}|${folders.map((f) => `${f.folder.name}${f.count}`).join("|")}`;
  const [measured, setMeasured] = useState(shape);
  if (measured !== shape) {
    setMeasured(shape);
    setFit(FOLDER_CHIPS);
  }
  useLayoutEffect(() => {
    const rows = new Set(
      [...(ref.current?.children ?? [])].map((child) => (child as HTMLElement).offsetTop),
    );
    if (rows.size > 2 && fit > 0) setFit(fit - 1);
  });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [folders.length > 0]);
  if (folders.length === 0) return null;
  return (
    <div
      ref={ref}
      role="group"
      aria-label="Folders"
      className="flex flex-wrap items-center gap-1.5 px-2 pb-1"
    >
      <Chip pressed={!picked} onClick={() => onPick(null)}>
        All
        <ChipCount count={total} pressed={!picked} />
      </Chip>
      {chips.map(({ folder, count, needsYou }) => {
        const on = folder.id === picked?.folder.id;
        return (
          <Chip
            key={folder.id}
            pressed={on}
            onClick={() => onPick(folder.id)}
            tooltip={folder.name.length > 14 ? folder.name : undefined}
          >
            <span className="max-w-24 truncate">{folder.name}</span>
            <ChipCount count={count} pressed={on} />
            {/* First in the chip, though after its name for screen readers. */}
            {needsYou && <NeedsYouDot className="order-first" />}
          </Chip>
        );
      })}
      {hidden > 0 && (
        <Chip dashed onClick={() => openSearch({ tab: "folders" })}>
          {hidden} more
        </Chip>
      )}
      {picked && nav.role !== "viewer" && (
        <DropdownMenu>
          <WithTooltip label="Folder actions">
            <DropdownMenuTrigger className="inline-flex size-6 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring aria-expanded:bg-sidebar-accent">
              <MoreHorizontalIcon className="size-4" />
              <span className="sr-only">Actions for {picked.folder.name}</span>
            </DropdownMenuTrigger>
          </WithTooltip>
          <DropdownMenuContent className="w-48" align="start">
            <DropdownMenuItem onClick={() => onStart(picked.folder.id)}>
              <PlusIcon />
              New thread
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => nav.act({ kind: "rename-folder", folder: picked.folder })}
            >
              <PencilIcon />
              Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => nav.act({ kind: "delete-folder", folder: picked.folder })}
            >
              <Trash2Icon />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
