// The dialogs behind the sidebar's folder and thread menus: naming a new folder, renaming a folder
// or a thread, moving a thread to a folder or the top of the space, and deleting a folder.

import { useQueryClient } from "@tanstack/react-query";

import type { FolderSummary } from "@/shared/folders.ts";
import type { ThreadSummary } from "@/shared/threads.ts";
import { NameDialog } from "@/web/components/name-dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/web/components/ui/alert-dialog";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/web/components/ui/command";
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";
import { threadQuery } from "@/web/lib/queries";

export type NavAction =
  | { kind: "new-folder" }
  | { kind: "rename-folder"; folder: FolderSummary }
  | { kind: "rename-thread"; thread: ThreadSummary }
  | { kind: "move-thread"; thread: ThreadSummary }
  | { kind: "delete-folder"; folder: FolderSummary };

export function NavDialogs({
  spaceId,
  folders,
  action,
  onClose,
  onReveal,
}: {
  spaceId: string;
  folders: FolderSummary[];
  action: NavAction | null;
  onClose: () => void;
  // Opens the folder a thread was just moved to.
  onReveal: (folderId: string | null) => void;
}) {
  const queryClient = useQueryClient();

  async function refresh(threadId?: string) {
    await queryClient.invalidateQueries({ queryKey: ["spaces", spaceId] });
    if (threadId) await queryClient.invalidateQueries({ queryKey: threadQuery(threadId).queryKey });
  }

  async function createFolder(name: string) {
    const res = await apiClient.v1.spaces[":id"].folders.$post({
      param: { id: spaceId },
      json: { name },
    });
    if (!res.ok) return errorOf(res);
    await refresh();
    return undefined;
  }

  async function renameFolder(id: string, name: string) {
    const res = await apiClient.v1.folders[":id"].$patch({ param: { id }, json: { name } });
    if (!res.ok) return errorOf(res);
    await refresh();
    return undefined;
  }

  async function changeThread(id: string, json: { title?: string; folderId?: string | null }) {
    const res = await apiClient.v1.threads[":id"].$patch({ param: { id }, json });
    if (!res.ok) return errorOf(res);
    if (json.folderId !== undefined) onReveal(json.folderId);
    await refresh(id);
    return undefined;
  }

  async function deleteFolder(id: string) {
    const res = await apiClient.v1.folders[":id"].$delete({ param: { id } });
    if (res.ok) await refresh();
    onClose();
  }

  function closed(open: boolean) {
    if (!open) onClose();
  }

  async function moveTo(folderId: string | null) {
    if (action?.kind === "move-thread") await changeThread(action.thread.id, { folderId });
    onClose();
  }

  return (
    <>
      <NameDialog
        title="New folder"
        action="Create"
        open={action?.kind === "new-folder"}
        onOpenChange={closed}
        onSubmit={createFolder}
      />
      <NameDialog
        key={action?.kind === "rename-folder" ? action.folder.id : "rename-folder"}
        title="Rename folder"
        action="Rename"
        initialName={action?.kind === "rename-folder" ? action.folder.name : ""}
        open={action?.kind === "rename-folder"}
        onOpenChange={closed}
        onSubmit={(name) =>
          action?.kind === "rename-folder"
            ? renameFolder(action.folder.id, name)
            : Promise.resolve(undefined)
        }
      />
      <NameDialog
        key={action?.kind === "rename-thread" ? action.thread.id : "rename-thread"}
        title="Rename thread"
        action="Rename"
        maxLength={200}
        initialName={action?.kind === "rename-thread" ? action.thread.title : ""}
        open={action?.kind === "rename-thread"}
        onOpenChange={closed}
        onSubmit={(title) =>
          action?.kind === "rename-thread"
            ? changeThread(action.thread.id, { title })
            : Promise.resolve(undefined)
        }
      />
      {/* Its title and description are in the page even while closed, so it only exists open. */}
      {action?.kind === "move-thread" && (
        <CommandDialog
          open
          onOpenChange={closed}
          title={`Move ${action.thread.title}`}
          description="Choose a folder, or the top of the space."
        >
          <Command>
            <CommandInput placeholder="Move to…" />
            <CommandList>
              <CommandEmpty>No folder matches.</CommandEmpty>
              <CommandGroup>
                <CommandItem value="top of the space" onSelect={() => void moveTo(null)}>
                  Top of the space
                </CommandItem>
                {folders.map((folder) => (
                  <CommandItem
                    key={folder.id}
                    value={`${folder.name} ${folder.id}`}
                    onSelect={() => void moveTo(folder.id)}
                  >
                    {folder.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </CommandDialog>
      )}
      <AlertDialog open={action?.kind === "delete-folder"} onOpenChange={closed}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {action?.kind === "delete-folder" ? action.folder.name : "folder"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Its threads move to the top of the space.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (action?.kind === "delete-folder") void deleteFolder(action.folder.id);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
