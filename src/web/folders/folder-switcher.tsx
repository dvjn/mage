// The sidebar's folder filter: a row saying "All threads" or the picked folder's name, opening the
// folder picker a thread's breadcrumb has, a folder marked with a dot while one inside needs the
// person. The picked folder's actions sit in a menu at the row's end, shown on hover or focus.
// Viewers have no actions.

import { cn } from "cn";
import { FolderIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";

import type { FolderSummary } from "@/shared/folders.ts";
import type { SpaceSummary } from "@/shared/spaces.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/web/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/web/components/ui/sidebar";
import { WithTooltip } from "@/web/components/with-tooltip";
import type { FolderActivity } from "@/web/folders/folder-activity";
import { FolderPicker } from "@/web/folders/folder-choice";
import type { FolderAction } from "@/web/folders/folder-dialogs";
import { NeedsYouDot } from "@/web/threads/thread-status";

export function FolderSwitcher({
  spaceId,
  folders,
  picked,
  onPick,
  onStart,
  act,
  role,
}: {
  spaceId: string;
  folders: FolderActivity[];
  picked: FolderActivity | undefined;
  onPick: (folderId: string | null) => void;
  // Starts a thread in the folder.
  onStart: (folderId: string) => void;
  act: (action: FolderAction) => void;
  role: SpaceSummary["role"];
}) {
  const { isMobile } = useSidebar();
  const actions = role !== "viewer";
  const byId = new Map(folders.map((f) => [f.folder.id, f]));
  const detail = (folder: FolderSummary) =>
    byId.get(folder.id)?.needsYou ? <NeedsYouDot /> : null;
  return (
    <SidebarMenu aria-label="Folder" className="mb-1">
      <SidebarMenuItem>
        <FolderPicker
          spaceId={spaceId}
          folders={folders.map((f) => f.folder)}
          value={picked?.folder.id ?? null}
          onChange={onPick}
          none="All threads"
          detail={detail}
          trigger={
            <SidebarMenuButton
              className={cn("aria-expanded:bg-sidebar-accent", picked && actions && "pr-8")}
            />
          }
        >
          <FolderIcon className="text-muted-foreground" />
          <span className="truncate font-medium">
            {picked ? picked.folder.name : "All threads"}
          </span>
        </FolderPicker>
        {picked && actions && (
          <DropdownMenu>
            <WithTooltip label="Folder actions">
              <DropdownMenuTrigger
                render={
                  <SidebarMenuAction className="peer-hover/menu-button:opacity-100 hover:opacity-100 focus-visible:opacity-100 aria-expanded:bg-muted aria-expanded:opacity-100 md:opacity-0" />
                }
              >
                <MoreHorizontalIcon />
                <span className="sr-only">Actions for {picked.folder.name}</span>
              </DropdownMenuTrigger>
            </WithTooltip>
            <DropdownMenuContent
              className="w-48"
              side={isMobile ? "bottom" : "right"}
              align="start"
            >
              <DropdownMenuItem onClick={() => onStart(picked.folder.id)}>
                <PlusIcon />
                New thread
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => act({ kind: "rename-folder", folder: picked.folder })}
              >
                <PencilIcon />
                Rename
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => act({ kind: "delete-folder", folder: picked.folder })}
              >
                <Trash2Icon />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
