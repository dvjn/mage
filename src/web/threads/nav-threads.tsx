// The sidebar's space and threads sections. The space section starts a thread or a folder and opens the space's settings. The threads section
// has chips to pick a folder, or all of the space: all first, then the few most recently active
// folders, each with how many threads it holds and a dot while one inside needs the person, then
// one that leads to the rest in the search; the picked one is remembered, and its menu starts a
// thread in it, renames or deletes it. Below, the threads picked are grouped: those that wait on
// the person or failed since they looked, those the agent works on, those with something new, all
// of them; then the few most recent of today and of the previous 7 days. A last row leads to the
// search for those left out. Rows stay where they are while the pointer is over the list. Each row
// has a menu to rename, move or delete. Nobody sees what their role never allows. In the shared
// context, the threads shared with the person are grouped the same, each with the space it is in.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { Link, useMatchRoute, useNavigate, useParams } from "@tanstack/react-router";
import {
  FolderInputIcon,
  FolderPlusIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  Settings2Icon,
  Trash2Icon,
} from "lucide-react";
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { FolderSummary } from "@/shared/folders.ts";
import type { SharedThread } from "@/shared/guests.ts";
import type { SpaceSummary } from "@/shared/spaces.ts";
import { statusOf } from "@/shared/thread-status.ts";
import type { ThreadActivity, ThreadListItem, ThreadSummary } from "@/shared/threads.ts";
import { type NavAction, NavDialogs } from "@/web/folders/nav-dialogs";
import { FolderPickerDialog } from "@/web/folders/folder-choice";
import { ShortcutHint } from "@/web/components/shortcut-keys";
import { useToast } from "@/web/app/toaster";
import { ThreadRow } from "@/web/threads/thread-row";
import { type SearchStart, useOpenThreadSearch } from "@/web/threads/thread-search";
import { NeedsYouDot } from "@/web/threads/thread-status";
import { WithTooltip } from "@/web/components/with-tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/web/components/ui/dropdown-menu";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  useSidebar,
} from "@/web/components/ui/sidebar";
import { usePlace } from "@/web/spaces/active-space";
import { apiClient } from "@/web/api/api-client";
import { errorOf } from "@/web/api/api-errors";
import { type FolderActivity, useFolderActivity } from "@/web/folders/folder-activity";
import { usePickedFolder } from "@/web/folders/picked-folder";
import { meQuery } from "@/web/auth/queries";
import { sharedThreadsQuery } from "@/web/guests/queries";
import { spaceThreadsQuery } from "@/web/threads/queries";
import { useShortcut } from "@/web/lib/shortcuts";
import { groupOf, type ThreadGroup } from "@/web/threads/thread-groups";

// How many folders have a chip of their own.
const FOLDER_CHIPS = 4;
// The most threads of today, and of the previous 7 days, listed; older ones never are.
const RECENT_LIMIT = 4;

const LIMITS: Partial<Record<ThreadGroup, number>> = {
  Today: RECENT_LIMIT,
  "Previous 7 days": RECENT_LIMIT,
  Older: 0,
};

// Opens a new thread's draft in the space, in a folder or at its top; the thread is made when its
// first message is sent.
export function useNewThread() {
  const navigate = useNavigate();
  return useCallback(
    (spaceId: string, folderId?: string) =>
      void navigate({
        to: "/s/$spaceId/new",
        params: { spaceId },
        search: folderId ? { folder: folderId } : {},
      }),
    [navigate],
  );
}

interface Nav {
  activeThreadId: string | undefined;
  act: (action: NavAction) => void;
  folders: FolderSummary[];
  spaceId: string;
  // Moves a thread to a folder or out of one; a failure is told in a toast.
  move: (thread: ThreadSummary, folderId: string | null) => void;
  role: SpaceSummary["role"];
}

const NavContext = createContext<Nav | null>(null);

function useNav() {
  const nav = use(NavContext);
  if (!nav) throw new Error("items need the nav context");
  return nav;
}

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

function ThreadItem({ thread, place }: { thread: ThreadListItem; place?: string }) {
  const nav = useNav();
  const [moving, setMoving] = useState(false);
  return (
    <ThreadRow
      variant="sidebar"
      thread={thread}
      place={place}
      isActive={thread.id === nav.activeThreadId}
    >
      {nav.role !== "viewer" && (
        <ItemMenu name={thread.title}>
          <DropdownMenuItem onClick={() => nav.act({ kind: "rename-thread", thread })}>
            <PencilIcon />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setMoving(true)}>
            <FolderInputIcon />
            Move to
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
      <FolderPickerDialog
        spaceId={nav.spaceId}
        title={thread.title}
        folders={nav.folders}
        value={thread.folderId}
        open={moving}
        onOpenChange={setMoving}
        onChange={(folderId) => nav.move(thread, folderId)}
      />
    </ThreadRow>
  );
}

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
function FolderChips({
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

type Grouped = { id: string; updatedAt: string; activity: ThreadActivity };

// Where each thread sits in the list: its group and place in it.
type Layout = Map<string, { group: ThreadGroup; index: number }>;

function layoutOf(threads: Grouped[], userId: string | undefined, now: Date): Layout {
  return new Map(
    threads.map((thread, index) => [
      thread.id,
      {
        group: groupOf(userId ? statusOf(thread.activity, userId) : "read", thread.updatedAt, now),
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
      return { group, count: all.length, list: all.slice(0, LIMITS[group] ?? all.length) };
    },
  );
  return groups.filter((g) => g.list.length > 0);
}

// The threads grouped, the pointer holding them in place, with a last row for those left out.
function GroupedThreads<T extends Grouped>({
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
  const me = useQuery(meQuery);
  const userId = me.data?.user.id;
  // The layout while the pointer is over the list, so rows do not move under it.
  const [held, setHeld] = useState<Layout | null>(null);
  const now = new Date();
  const fresh = layoutOf(threads, userId, now);
  const groups = grouping(threads, held ?? fresh, fresh);
  const shown = groups.reduce((sum, g) => sum + g.list.length, 0);
  const hidden = Math.max(total, threads.length) - shown;
  return (
    <SidebarMenu
      onPointerEnter={() => setHeld(layoutOf(threads, userId, now))}
      onPointerLeave={() => setHeld(null)}
    >
      {groups.map(({ group, count, list }) => (
        <li key={group} className="contents">
          <span
            aria-hidden
            className="flex px-2 pt-3 pb-1 pl-8 text-xs text-muted-foreground tabular-nums"
          >
            <span className="flex-1">{group}</span>
            {count}
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

// Rows of a list still being read, as tall as the rows to come.
function MenuSkeleton() {
  return [0, 1, 2].map((index) => (
    <SidebarMenuItem key={index}>
      <SidebarMenuSkeleton />
    </SidebarMenuItem>
  ));
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <SidebarMenuItem className="px-2 py-1.5 text-sm text-muted-foreground">
      {children}
    </SidebarMenuItem>
  );
}

function SpaceSection({ space, onNewFolder }: { space: SpaceSummary; onNewFolder: () => void }) {
  const matchRoute = useMatchRoute();
  const newThread = useNewThread();
  const writer = space.role === "owner" || space.role === "messager";
  // A viewer has nothing to do here.
  if (!writer && !space.manage) return null;
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Space</SidebarGroupLabel>
      <SidebarMenu>
        {writer && (
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={!!matchRoute({ to: "/s/$spaceId/new", params: { spaceId: space.id } })}
              onClick={() => newThread(space.id)}
            >
              <PlusIcon />
              <span>New thread</span>
              <ShortcutHint id="newThread" />
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
        {writer && (
          <SidebarMenuItem>
            <SidebarMenuButton onClick={onNewFolder}>
              <FolderPlusIcon />
              <span>New folder</span>
              <ShortcutHint id="newFolder" />
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
        {space.manage && (
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={
                !!matchRoute({
                  to: "/s/$spaceId/settings",
                  params: { spaceId: space.id },
                  fuzzy: true,
                })
              }
              render={<Link to="/s/$spaceId/settings" params={{ spaceId: space.id }} />}
            >
              <Settings2Icon />
              <span>Space settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
}

function SpaceThreads({ space }: { space: SpaceSummary }) {
  const folders = useFolderActivity(space.id);
  const threads = useQuery(spaceThreadsQuery(space.id));
  const { threadId } = useParams({ strict: false });
  const newThread = useNewThread();
  const openSearch = useOpenThreadSearch();
  const [pickedId, pick] = usePickedFolder(space.id);
  const toast = useToast();
  const queryClient = useQueryClient();
  const [action, setAction] = useState<NavAction | null>(null);
  useShortcut("newFolder", () => setAction({ kind: "new-folder" }), {
    enabled: space.role !== "viewer",
  });

  const nav = useMemo<Nav>(
    () => ({
      activeThreadId: threadId,
      act: setAction,
      folders: folders.map((f) => f.folder),
      spaceId: space.id,
      move: (thread, folderId) => {
        if (thread.folderId === folderId) return;
        void apiClient.v1.threads[":id"]
          .$patch({ param: { id: thread.id }, json: { folderId } })
          .then(async (res) => {
            if (!res.ok) {
              toast(await errorOf(res));
              return;
            }
            await queryClient.invalidateQueries({ queryKey: ["spaces", space.id] });
            await queryClient.invalidateQueries({ queryKey: ["threads", thread.id] });
          });
      },
      role: space.role,
    }),
    [threadId, space.id, space.role, folders, toast, queryClient],
  );

  // A folder deleted, or not read yet, leaves all of the space picked.
  const picked = folders.find((f) => f.folder.id === pickedId);
  const all = threads.data?.threads ?? [];
  const listed = picked ? all.filter((thread) => thread.folderId === picked.folder.id) : all;
  const spaceTotal = (threads.data?.loose ?? 0) + folders.reduce((sum, f) => sum + f.count, 0);
  const total = picked ? picked.count : spaceTotal;
  const folderNames = new Map(folders.map((f) => [f.folder.id, f.folder.name]));
  const search = (start: SearchStart = {}) =>
    openSearch(picked ? { ...start, folderId: picked.folder.id } : start);
  return (
    <>
      <SpaceSection space={space} onNewFolder={() => setAction({ kind: "new-folder" })} />
      <SidebarGroup>
        <SidebarGroupLabel>Threads</SidebarGroupLabel>
        <NavContext value={nav}>
          <FolderChips
            folders={folders}
            total={spaceTotal}
            picked={picked}
            onPick={pick}
            onStart={(folderId) => newThread(space.id, folderId)}
          />
          <GroupedThreads
            threads={listed}
            total={total}
            row={(thread) => (
              <ThreadItem
                key={thread.id}
                thread={thread}
                place={!picked && thread.folderId ? folderNames.get(thread.folderId) : undefined}
              />
            )}
            more={(hidden) =>
              picked ? `All ${total} in ${picked.folder.name}` : `${hidden} more threads`
            }
            onMore={() => search()}
          >
            {threads.isPending && <MenuSkeleton />}
            {threads.isSuccess && listed.length === 0 && (
              <Empty>
                {picked
                  ? "No threads"
                  : space.role === "viewer"
                    ? "No threads yet."
                    : "No threads yet. Start one above."}
              </Empty>
            )}
          </GroupedThreads>
        </NavContext>
      </SidebarGroup>
      <NavDialogs spaceId={space.id} action={action} onClose={() => setAction(null)} />
    </>
  );
}

// The threads shared with the person, grouped, each with the space it is in, and its org on hover.
function SharedThreads() {
  const shared = useQuery(sharedThreadsQuery);
  const { threadId } = useParams({ strict: false });
  const openSearch = useOpenThreadSearch();
  const list = shared.data ?? [];
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Shared with you</SidebarGroupLabel>
      <GroupedThreads
        threads={list}
        total={list.length}
        row={(thread: SharedThread) => (
          <ThreadRow
            key={thread.id}
            variant="sidebar"
            thread={thread}
            place={thread.spaceName}
            title={thread.place}
            isActive={thread.id === threadId}
          />
        )}
        more={(hidden) => `${hidden} more threads`}
        onMore={() => openSearch({ scope: "shared" })}
      >
        {shared.isPending && <MenuSkeleton />}
        {shared.isSuccess && list.length === 0 && <Empty>No threads are shared with you.</Empty>}
      </GroupedThreads>
    </SidebarGroup>
  );
}

export function NavThreads() {
  const place = usePlace();
  if (!place) return null;
  if (place.kind === "shared") return <SharedThreads />;
  // A space its org's owner manages without being in it shows them only its settings.
  if (place.space.role === null) return <SpaceSection space={place.space} onNewFolder={() => {}} />;
  return <SpaceThreads key={place.space.id} space={place.space} />;
}
