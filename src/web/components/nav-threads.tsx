// The sidebar's space and threads sections. The space section starts a thread or a folder and opens
// the space's settings; the threads section lists the active space's folders, closed unless they
// hold the open thread, then the threads at the top of the space by when they were last active
// (today, the previous 7 days, older). A folder's header counts its threads and, while it is closed,
// shows the statuses inside that say something, the most pressing first; its threads hang under it
// on a thin guide, their titles in line with its name. Each list stops at a limit, with "Show all"
// leading to the space's page, narrowed to the folder where it is one, for the rest. Rows stay
// where they are while the pointer is over the list, and never move for their status. Each row has
// a menu to start, rename, move or delete. Nobody sees what their role never allows. In the shared
// context, the section lists the threads shared with the person instead, each with the space it
// is in, up to the same limit. Above either, while any thread there or shared waits on the person
// or failed since they looked, "Needs you" lists the newest few, each with its folder or space,
// leading to the page for the rest.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { Link, useMatchRoute, useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderInputIcon,
  FolderPlusIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Settings2Icon,
  Trash2Icon,
} from "lucide-react";
import type * as React from "react";
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";

import type { FolderSummary } from "@/shared/folders.ts";
import type { SharedThread } from "@/shared/guests.ts";
import type { SpaceSummary } from "@/shared/spaces.ts";
import { statusOf, type ThreadStatus } from "@/shared/thread-status.ts";
import type { ThreadListItem, ThreadSummary } from "@/shared/threads.ts";
import { type NavAction, NavDialogs } from "@/web/components/nav-dialogs";
import { FolderPickerDialog } from "@/web/components/folder-choice";
import { ShortcutHint } from "@/web/components/shortcut-keys";
import { useToast } from "@/web/components/toaster";
import { slotUnderMenu, ThreadRow } from "@/web/components/thread-row";
import { StatusGlyph } from "@/web/components/thread-status";
import { WithTooltip } from "@/web/components/with-tooltip";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/web/components/ui/collapsible";
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
import { usePlace } from "@/web/lib/active-space";
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";
import { useShortcut } from "@/web/lib/shortcuts";
import { SECTIONS, type Section, sectionOf } from "@/web/lib/time-sections";
import { type NeedsYouItem, useNeedsYou } from "@/web/lib/needs-you";
import { useOpenFolders } from "@/web/lib/open-folders";
import {
  meQuery,
  sharedThreadsQuery,
  spaceFoldersQuery,
  spaceThreadsQuery,
} from "@/web/lib/queries";

// The most threads listed at the top of the space, in a folder or shared; the space's page and the
// shared page list them all.
const THREAD_LIMIT = 30;
// The most threads "Needs you" lists.
const NEEDS_YOU_LIMIT = 5;

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
  threads: Map<string | null, ThreadListItem[]>;
  activeThreadId: string | undefined;
  open: Set<string>;
  setFolderOpen: (id: string, open: boolean) => void;
  act: (action: NavAction) => void;
  startThread: (folderId: string) => void;
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

function groupBy<T>(items: T[], key: (item: T) => string | null) {
  const groups = new Map<string | null, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
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

function ThreadItem({ thread }: { thread: ThreadListItem }) {
  const nav = useNav();
  const [moving, setMoving] = useState(false);
  return (
    <ThreadRow variant="sidebar" thread={thread} isActive={thread.id === nav.activeThreadId}>
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

// The statuses that say something, the most pressing first.
const PRESSING: ThreadStatus[] = ["waiting", "failed", "working", "paused", "unread"];

// Each status in the threads that says something, once, with the first thread that has it.
function rollupOf(threads: ThreadListItem[], userId: string | undefined) {
  if (!userId) return [];
  const first = new Map<ThreadStatus, ThreadListItem>();
  for (const thread of threads) {
    const status = statusOf(thread.activity, userId);
    if (status !== "read" && !first.has(status)) first.set(status, thread);
  }
  return PRESSING.flatMap((status) => {
    const thread = first.get(status);
    return thread ? [[status, thread] as const] : [];
  });
}

// The end of a folder's header: while it is closed, the statuses inside that say something, then
// how many threads it holds. The menu stands over it while the pointer is over the header.
function Rollup({ id, threads, open }: { id: string; threads: ThreadListItem[]; open: boolean }) {
  const me = useQuery(meQuery);
  const rollup = open ? [] : rollupOf(threads, me.data?.user.id);
  return (
    <span
      id={id}
      // Told as the header's description, so its name stays the folder's.
      aria-hidden
      className={cn(
        "ml-auto flex shrink-0 items-center gap-1 overflow-visible! text-xs text-muted-foreground tabular-nums",
        slotUnderMenu,
      )}
    >
      {rollup.map(([status, thread]) => (
        <StatusGlyph key={status} status={status} activity={thread.activity} />
      ))}
      <span>
        {threads.length}
        <span className="sr-only">{threads.length === 1 ? " thread" : " threads"}</span>
      </span>
    </span>
  );
}

// The guide hangs from the folder icon's centre to just above the end of its list, clear of the
// rows, which are indented so their titles line up with the folder's name.
const guided =
  "relative flex flex-col gap-0.5 pt-0.5 pb-1.5 pl-6 before:absolute before:top-0 before:bottom-2 before:left-4 before:w-px before:bg-sidebar-border";

function FolderItem({ folder }: { folder: FolderSummary }) {
  const nav = useNav();
  const threads = nav.threads.get(folder.id) ?? [];
  const open = nav.open.has(folder.id);
  const rollupId = useId();
  return (
    <Collapsible
      open={open}
      onOpenChange={(open) => nav.setFolderOpen(folder.id, open)}
      render={<SidebarMenuItem />}
    >
      <CollapsibleTrigger
        aria-describedby={rollupId}
        render={
          <SidebarMenuButton className="md:group-has-data-[sidebar=menu-action]/menu-item:pr-2" />
        }
      >
        {open ? <FolderOpenIcon /> : <FolderIcon />}
        <span className="min-w-0 flex-1 truncate">{folder.name}</span>
        <Rollup id={rollupId} threads={threads} open={open} />
      </CollapsibleTrigger>
      {nav.role !== "viewer" && (
        <ItemMenu name={folder.name}>
          <DropdownMenuItem onClick={() => nav.startThread(folder.id)}>
            <PlusIcon />
            New thread
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => nav.act({ kind: "rename-folder", folder })}>
            <PencilIcon />
            Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => nav.act({ kind: "delete-folder", folder })}
          >
            <Trash2Icon />
            Delete
          </DropdownMenuItem>
        </ItemMenu>
      )}
      <CollapsibleContent>
        <ul className={guided} aria-label={folder.name}>
          {threads.length === 0 ? (
            <li className="flex h-8 items-center px-2 text-sm text-muted-foreground">No threads</li>
          ) : (
            threads
              .slice(0, THREAD_LIMIT)
              .map((thread) => <ThreadItem key={thread.id} thread={thread} />)
          )}
          {threads.length > THREAD_LIMIT && (
            <ShowAll
              link={
                <Link
                  to="/s/$spaceId"
                  params={{ spaceId: nav.spaceId }}
                  search={{ folder: folder.id }}
                />
              }
            />
          )}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

// Where each thread sits in the list: its section and place in it.
type Layout = Map<string, { section: Section; index: number }>;

function layoutOf(threads: ThreadSummary[], now: Date): Layout {
  return new Map(
    threads.map((thread, index) => [
      thread.id,
      { section: sectionOf(thread.updatedAt, now), index },
    ]),
  );
}

// The loose threads by section, in the layout given; threads it does not know yet come first in
// Today.
function sectioned<T extends ThreadSummary>(threads: T[], layout: Layout) {
  const placed = threads
    .map((thread) => ({ thread, at: layout.get(thread.id) ?? { section: "Today", index: -1 } }))
    .toSorted((a, b) => a.at.index - b.at.index);
  return SECTIONS.map(
    (section) =>
      [section, placed.filter((p) => p.at.section === section).map((p) => p.thread)] as const,
  ).filter(([, list]) => list.length > 0);
}

// The last row of a list cut at the limit, leading to the page that lists it all.
function ShowAll({ link }: { link: React.ReactElement }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton className="text-muted-foreground" render={link}>
        <span>Show all</span>
        <ArrowRightIcon className="ml-auto" />
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

// Rows of a list still being read, as tall as the rows to come.
function MenuSkeleton() {
  return [0, 1, 2].map((index) => (
    <SidebarMenuItem key={index}>
      <SidebarMenuSkeleton className="h-12" />
    </SidebarMenuItem>
  ));
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
  const folders = useQuery(spaceFoldersQuery(space.id));
  const threads = useQuery(spaceThreadsQuery(space.id));
  const { threadId } = useParams({ strict: false });
  const newThread = useNewThread();
  const { open, setFolderOpen } = useOpenFolders();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [action, setAction] = useState<NavAction | null>(null);
  // The layout while the pointer is over the list, so rows do not move under it.
  const [held, setHeld] = useState<Layout | null>(null);
  const folderList = useMemo(() => folders.data ?? [], [folders.data]);
  useShortcut("newFolder", () => setAction({ kind: "new-folder" }), {
    enabled: space.role !== "viewer",
  });

  // The open thread's folder opens with it.
  const activeFolderId = threads.data?.find((thread) => thread.id === threadId)?.folderId;
  useEffect(() => {
    if (activeFolderId) setFolderOpen(activeFolderId, true);
  }, [activeFolderId, setFolderOpen]);

  const nav = useMemo<Nav>(
    () => ({
      threads: groupBy(threads.data ?? [], (thread) => thread.folderId),
      activeThreadId: threadId,
      open,
      setFolderOpen,
      act: setAction,
      startThread: (folderId) => newThread(space.id, folderId),
      folders: folderList,
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
            if (folderId) setFolderOpen(folderId, true);
            await queryClient.invalidateQueries({ queryKey: ["spaces", space.id] });
            await queryClient.invalidateQueries({ queryKey: ["threads", thread.id] });
          });
      },
      role: space.role,
    }),
    [
      threads.data,
      threadId,
      open,
      setFolderOpen,
      newThread,
      space.id,
      space.role,
      folderList,
      toast,
      queryClient,
    ],
  );

  const { isMobile } = useSidebar();
  const needsYou = (
    <NeedsYou
      folderNames={new Map(folderList.map((folder) => [folder.id, folder.name]))}
      more={<Link to="/s/$spaceId" params={{ spaceId: space.id }} search={{ show: "needs-you" }} />}
    />
  );
  const loose = nav.threads.get(null) ?? [];
  const now = new Date();
  const layout = held ?? layoutOf(loose, now);
  const shown = loose.slice(0, THREAD_LIMIT);
  const empty = threads.isSuccess && folderList.length === 0 && loose.length === 0;
  return (
    <>
      {/* On a phone it is the drawer's first group. */}
      {isMobile && needsYou}
      <SpaceSection space={space} onNewFolder={() => setAction({ kind: "new-folder" })} />
      {!isMobile && needsYou}
      <SidebarGroup
        onPointerEnter={() => setHeld(layoutOf(loose, now))}
        onPointerLeave={() => setHeld(null)}
      >
        <SidebarGroupLabel>Threads</SidebarGroupLabel>
        <SidebarMenu>
          <NavContext value={nav}>
            {folderList.map((folder) => (
              <FolderItem key={folder.id} folder={folder} />
            ))}
            {sectioned(shown, layout).map(([section, list]) => (
              <li key={section} className="contents">
                <span className="block px-2 pt-3 pb-1 text-xs text-muted-foreground">
                  {section}
                </span>
                <ul className="flex flex-col gap-0.5" aria-label={section}>
                  {list.map((thread) => (
                    <ThreadItem key={thread.id} thread={thread} />
                  ))}
                </ul>
              </li>
            ))}
            {loose.length > THREAD_LIMIT && (
              <ShowAll link={<Link to="/s/$spaceId" params={{ spaceId: space.id }} />} />
            )}
            {threads.isPending && <MenuSkeleton />}
            {empty && (
              <SidebarMenuItem className="px-2 py-1.5 text-sm text-muted-foreground">
                {space.role === "viewer" ? "No threads yet." : "No threads yet. Start one above."}
              </SidebarMenuItem>
            )}
          </NavContext>
        </SidebarMenu>
      </SidebarGroup>
      <NavDialogs spaceId={space.id} action={action} onClose={() => setAction(null)} />
    </>
  );
}

// A thread shared with the person, with the space it is in, and its org on hover.
function SharedItem({ thread, isActive }: { thread: SharedThread; isActive: boolean }) {
  return (
    <ThreadRow
      variant="sidebar"
      thread={thread}
      place={thread.spaceName}
      title={thread.place}
      isActive={isActive}
    />
  );
}

// The threads that wait on the person or failed since they looked, newest first, up to a few, each
// with its folder, by the names given, or its space when shared, leading to the page that lists the
// rest; nothing while there are none.
function NeedsYou({
  more,
  folderNames,
}: {
  more: React.ReactElement;
  folderNames?: Map<string, string>;
}) {
  const items = useNeedsYou();
  const { threadId } = useParams({ strict: false });
  if (items.length === 0) return null;
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Needs you</SidebarGroupLabel>
      <SidebarMenu aria-label="Needs you">
        {items
          .slice(0, NEEDS_YOU_LIMIT)
          .map((item: NeedsYouItem) =>
            item.kind === "shared" ? (
              <SharedItem
                key={item.thread.id}
                thread={item.thread}
                isActive={item.thread.id === threadId}
              />
            ) : (
              <ThreadRow
                key={item.thread.id}
                variant="sidebar"
                thread={item.thread}
                place={item.thread.folderId ? folderNames?.get(item.thread.folderId) : undefined}
                isActive={item.thread.id === threadId}
              />
            ),
          )}
        {items.length > NEEDS_YOU_LIMIT && (
          <SidebarMenuItem>
            <SidebarMenuButton className="text-muted-foreground" render={more}>
              <span>{items.length - NEEDS_YOU_LIMIT} more</span>
              <ArrowRightIcon className="ml-auto" />
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
}

// The threads shared with the person, most recently active first.
function SharedThreads() {
  const shared = useQuery(sharedThreadsQuery);
  const { threadId } = useParams({ strict: false });
  const list = shared.data ?? [];
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Shared with you</SidebarGroupLabel>
      <SidebarMenu>
        {list.slice(0, THREAD_LIMIT).map((thread) => (
          <SharedItem key={thread.id} thread={thread} isActive={thread.id === threadId} />
        ))}
        {list.length > THREAD_LIMIT && <ShowAll link={<Link to="/shared" />} />}
        {shared.isPending && <MenuSkeleton />}
        {shared.isSuccess && list.length === 0 && (
          <SidebarMenuItem className="px-2 py-1.5 text-sm text-muted-foreground">
            No threads are shared with you.
          </SidebarMenuItem>
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
}

export function NavThreads() {
  const place = usePlace();
  if (!place) return null;
  if (place.kind === "shared") {
    return (
      <>
        <NeedsYou more={<Link to="/shared" search={{ show: "needs-you" }} />} />
        <SharedThreads />
      </>
    );
  }
  // A space its org's owner manages without being in it shows them only its settings.
  if (place.space.role === null) return <SpaceSection space={place.space} onNewFolder={() => {}} />;
  return <SpaceThreads key={place.space.id} space={place.space} />;
}
