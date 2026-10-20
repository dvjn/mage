// The sidebar's space and threads sections: starting a thread or folder, then the active space's
// folders with their threads, the threads at the top of the space after them, and a menu on each
// to start, rename, move or delete them.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  FolderIcon,
  FolderOpenIcon,
  FolderInputIcon,
  FolderPlusIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { createContext, type ReactNode, use, useEffect, useMemo, useState } from "react";

import type { FolderSummary } from "@/shared/folders.ts";
import { threadSchema, type ThreadSummary } from "@/shared/threads.ts";
import { type NavAction, NavDialogs } from "@/web/components/nav-dialogs";
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
  SidebarMenuSub,
  SidebarMenuSubItem,
  useSidebar,
} from "@/web/components/ui/sidebar";
import { useActiveSpace } from "@/web/lib/active-space";
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";
import { useOpenFolders } from "@/web/lib/open-folders";
import { spaceFoldersQuery, spaceThreadsQuery } from "@/web/lib/queries";

// Makes a thread in the space, in a folder or at its top, and opens it.
export function useNewThread() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return async (spaceId: string, text?: string, folderId?: string) => {
    const res = await apiClient.v1.spaces[":id"].threads.$post({
      param: { id: spaceId },
      json: { ...(text && { text }), ...(folderId && { folderId }) },
    });
    if (!res.ok) return errorOf(res);
    const thread = threadSchema.parse(await res.json());
    await queryClient.invalidateQueries({ queryKey: spaceThreadsQuery(spaceId).queryKey });
    await navigate({ to: "/t/$threadId", params: { threadId: thread.id } });
    return undefined;
  };
}

interface Nav {
  threads: Map<string | null, ThreadSummary[]>;
  activeThreadId: string | undefined;
  open: Set<string>;
  setFolderOpen: (id: string, open: boolean) => void;
  act: (action: NavAction) => void;
  startThread: (folderId: string) => void;
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
        <span>{thread.title}</span>
      </SidebarMenuButton>
      <ItemMenu name={thread.title}>
        <DropdownMenuItem onClick={() => nav.act({ kind: "rename-thread", thread })}>
          <PencilIcon />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => nav.act({ kind: "move-thread", thread })}>
          <FolderInputIcon />
          Move to…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() => nav.act({ kind: "delete-thread", thread })}
        >
          <Trash2Icon />
          Delete
        </DropdownMenuItem>
      </ItemMenu>
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
      <ItemMenu name={folder.name}>
        <DropdownMenuItem onClick={() => nav.startThread(folder.id)}>
          <PlusIcon />
          New thread
        </DropdownMenuItem>
        <DropdownMenuSeparator />
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

export function NavThreads() {
  const space = useActiveSpace();
  const spaceId = space?.id ?? "";
  const folders = useQuery({ ...spaceFoldersQuery(spaceId), enabled: !!space });
  const threads = useQuery({ ...spaceThreadsQuery(spaceId), enabled: !!space });
  const { threadId } = useParams({ strict: false });
  const newThread = useNewThread();
  const { open, setFolderOpen } = useOpenFolders();
  const [action, setAction] = useState<NavAction | null>(null);
  const folderList = useMemo(() => folders.data ?? [], [folders.data]);

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
      startThread: (folderId) => void newThread(spaceId, undefined, folderId),
    }),
    [folderList, threads.data, threadId, open, setFolderOpen, newThread, spaceId],
  );

  if (!space) return null;
  return (
    <>
      <SidebarGroup>
        <SidebarGroupLabel>Space</SidebarGroupLabel>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => void newThread(space.id)}>
              <PlusIcon />
              <span>New thread</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => setAction({ kind: "new-folder" })}>
              <FolderPlusIcon />
              <span>New folder</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
      <SidebarGroup>
        <SidebarGroupLabel>Threads</SidebarGroupLabel>
        <SidebarMenu>
          <NavContext value={nav}>
            {folderList.map((folder) => (
              <FolderItem key={folder.id} folder={folder} />
            ))}
            {nav.threads.get(null)?.map((thread) => (
              <ThreadItem key={thread.id} thread={thread} />
            ))}
          </NavContext>
        </SidebarMenu>
      </SidebarGroup>
      <NavDialogs
        spaceId={space.id}
        folders={folderList}
        action={action}
        onClose={() => setAction(null)}
        onReveal={(folderId) => {
          if (folderId) setFolderOpen(folderId, true);
        }}
      />
    </>
  );
}
