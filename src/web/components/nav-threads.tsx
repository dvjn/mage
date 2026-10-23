// The sidebar's space and threads sections. The space section starts a thread or a folder and opens
// the space's settings; the threads section lists the active space's folders, closed unless they
// hold the open thread, then the threads at the top of the space by when they were last active
// (today, the previous 7 days, older), up to a limit, with the space's page for the rest. Rows stay
// where they are while the pointer is over the list. Each row has a menu to start, rename, move or
// delete. Nobody sees what their role never allows. In the shared context, the section lists the
// threads shared with the person instead, each over the space it is in.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useMatchRoute, useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderInputIcon,
  FolderPlusIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Settings2Icon,
  Trash2Icon,
} from "lucide-react";
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import type { FolderSummary } from "@/shared/folders.ts";
import type { SpaceSummary } from "@/shared/spaces.ts";
import type { ThreadSummary } from "@/shared/threads.ts";
import { type NavAction, NavDialogs } from "@/web/components/nav-dialogs";
import { FolderChoices } from "@/web/components/folder-choice";
import { ShortcutHint } from "@/web/components/shortcut-keys";
import { useToast } from "@/web/components/toaster";
import { ThreadTitle } from "@/web/components/thread-title";
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
  SidebarMenuSub,
  SidebarMenuSubItem,
  useSidebar,
} from "@/web/components/ui/sidebar";
import { usePlace } from "@/web/lib/active-space";
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";
import { useShortcut } from "@/web/lib/shortcuts";
import { SECTIONS, type Section, sectionOf } from "@/web/lib/time-sections";
import { useOpenFolders } from "@/web/lib/open-folders";
import { sharedThreadsQuery, spaceFoldersQuery, spaceThreadsQuery } from "@/web/lib/queries";

// The most threads listed at the top of the space; the space's page lists them all.
const THREAD_LIMIT = 30;

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
  threads: Map<string | null, ThreadSummary[]>;
  activeThreadId: string | undefined;
  open: Set<string>;
  setFolderOpen: (id: string, open: boolean) => void;
  act: (action: NavAction) => void;
  startThread: (folderId: string) => void;
  folders: FolderSummary[];
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
      <DropdownMenuTrigger
        render={
          <SidebarMenuAction className="peer-hover/menu-button:opacity-100 hover:opacity-100 focus-visible:opacity-100 aria-expanded:bg-muted aria-expanded:opacity-100 md:opacity-0" />
        }
      >
        <MoreHorizontalIcon />
        <span className="sr-only">Actions for {name}</span>
      </DropdownMenuTrigger>
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

function ThreadItem({ thread }: { thread: ThreadSummary }) {
  const nav = useNav();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={thread.id === nav.activeThreadId}
        render={<Link to="/t/$threadId" params={{ threadId: thread.id }} />}
      >
        <MessageSquareIcon />
        <ThreadTitle thread={thread} />
      </SidebarMenuButton>
      {nav.role !== "viewer" && (
        <ItemMenu name={thread.title}>
          <DropdownMenuItem onClick={() => nav.act({ kind: "rename-thread", thread })}>
            <PencilIcon />
            Rename…
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <FolderInputIcon />
              Move to
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-44">
              <FolderChoices
                folders={nav.folders}
                value={thread.folderId}
                onChange={(folderId) => nav.move(thread, folderId)}
              />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
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
    </SidebarMenuItem>
  );
}

function FolderItem({ folder }: { folder: FolderSummary }) {
  const nav = useNav();
  const threads = nav.threads.get(folder.id) ?? [];
  return (
    <Collapsible
      open={nav.open.has(folder.id)}
      onOpenChange={(open) => nav.setFolderOpen(folder.id, open)}
      render={<SidebarMenuItem />}
    >
      <CollapsibleTrigger render={<SidebarMenuButton />}>
        {nav.open.has(folder.id) ? <FolderOpenIcon /> : <FolderIcon />}
        <span>{folder.name}</span>
      </CollapsibleTrigger>
      {nav.role !== "viewer" && (
        <ItemMenu name={folder.name}>
          <DropdownMenuItem onClick={() => nav.startThread(folder.id)}>
            <PlusIcon />
            New thread
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => nav.act({ kind: "rename-folder", folder })}>
            <PencilIcon />
            Rename…
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
        <SidebarMenuSub className="mr-0 pr-0">
          {threads.length === 0 ? (
            <SidebarMenuSubItem className="flex h-8 items-center px-2 text-sm text-muted-foreground">
              No threads
            </SidebarMenuSubItem>
          ) : (
            threads.map((thread) => <ThreadItem key={thread.id} thread={thread} />)
          )}
        </SidebarMenuSub>
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
function sectioned(threads: ThreadSummary[], layout: Layout) {
  const placed = threads
    .map((thread) => ({ thread, at: layout.get(thread.id) ?? { section: "Today", index: -1 } }))
    .toSorted((a, b) => a.at.index - b.at.index);
  return SECTIONS.map(
    (section) =>
      [section, placed.filter((p) => p.at.section === section).map((p) => p.thread)] as const,
  ).filter(([, list]) => list.length > 0);
}

// Rows of a list still being read.
function MenuSkeleton() {
  return [0, 1, 2].map((index) => (
    <SidebarMenuItem key={index}>
      <SidebarMenuSkeleton showIcon />
    </SidebarMenuItem>
  ));
}

function SpaceSection({ space, onNewFolder }: { space: SpaceSummary; onNewFolder: () => void }) {
  const matchRoute = useMatchRoute();
  const newThread = useNewThread();
  const writer = space.role !== "viewer";
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
        <SidebarMenuItem>
          <SidebarMenuButton
            isActive={!!matchRoute({ to: "/s/$spaceId/settings", params: { spaceId: space.id } })}
            render={<Link to="/s/$spaceId/settings" params={{ spaceId: space.id }} />}
          >
            <Settings2Icon />
            <span>Space settings</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
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

  const loose = nav.threads.get(null) ?? [];
  const now = new Date();
  const layout = held ?? layoutOf(loose, now);
  const shown = loose.slice(0, THREAD_LIMIT);
  const empty = threads.isSuccess && folderList.length === 0 && loose.length === 0;
  return (
    <>
      <SpaceSection space={space} onNewFolder={() => setAction({ kind: "new-folder" })} />
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
              <SidebarMenuItem>
                <SidebarMenuButton
                  className="text-muted-foreground"
                  render={<Link to="/s/$spaceId" params={{ spaceId: space.id }} />}
                >
                  <span>All threads</span>
                  <ArrowRightIcon className="ml-auto" />
                </SidebarMenuButton>
              </SidebarMenuItem>
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

// The threads shared with the person, most recently active first.
function SharedThreads() {
  const shared = useQuery(sharedThreadsQuery);
  const { threadId } = useParams({ strict: false });
  const list = shared.data ?? [];
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Shared with you</SidebarGroupLabel>
      <SidebarMenu>
        {list.map((thread) => (
          <SidebarMenuItem key={thread.id}>
            <WithTooltip label={thread.place}>
              <SidebarMenuButton
                size="lg"
                isActive={thread.id === threadId}
                render={<Link to="/t/$threadId" params={{ threadId: thread.id }} />}
              >
                <MessageSquareIcon />
                <span className="grid min-w-0 leading-tight">
                  <ThreadTitle thread={thread} className="truncate" />
                  <span className="truncate text-xs text-muted-foreground">{thread.spaceName}</span>
                </span>
              </SidebarMenuButton>
            </WithTooltip>
          </SidebarMenuItem>
        ))}
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
  if (place.kind === "shared") return <SharedThreads />;
  return <SpaceThreads key={place.space.id} space={place.space} />;
}
