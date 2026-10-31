// The dialogs behind the sidebar's folder and thread menus: naming a new folder, renaming a folder
// or a thread, and deleting a folder or a thread. Deleting the open thread leads back to its space.
// A delete that fails says why in its dialog, which stays open.

import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";

import type { FolderSummary } from "@/shared/folders.ts";
import type { ThreadSummary } from "@/shared/threads.ts";
import { NameDialog } from "@/web/components/name-dialog";
import { FieldError } from "@/web/components/ui/field";
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
import { apiClient } from "@/web/api/api-client";
import { errorOf } from "@/web/api/api-errors";
import { threadQuery } from "@/web/threads/queries";

export type NavAction =
  | { kind: "new-folder" }
  | { kind: "rename-folder"; folder: FolderSummary }
  | { kind: "rename-thread"; thread: ThreadSummary }
  | { kind: "delete-folder"; folder: FolderSummary }
  | { kind: "delete-thread"; thread: ThreadSummary };

export function NavDialogs({
  spaceId,
  action,
  onClose,
}: {
  spaceId: string;
  action: NavAction | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { threadId: openThreadId } = useParams({ strict: false });
  // Why the last move or delete failed, shown in its dialog.
  const [failed, setFailed] = useState<string>();

  function fail(message: string) {
    setFailed(message);
  }

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

  async function renameThread(id: string, json: { title: string }) {
    const res = await apiClient.v1.threads[":id"].$patch({ param: { id }, json });
    if (!res.ok) return errorOf(res);
    await refresh(id);
    return undefined;
  }

  async function deleteFolder(id: string) {
    const res = await apiClient.v1.folders[":id"].$delete({ param: { id } });
    if (!res.ok) {
      fail(await errorOf(res));
      return;
    }
    await refresh();
    closed(false);
  }

  async function deleteThread(id: string) {
    const res = await apiClient.v1.threads[":id"].$delete({ param: { id } });
    if (!res.ok) {
      fail(await errorOf(res));
      return;
    }
    if (id === openThreadId) await navigate({ to: "/s/$spaceId", params: { spaceId } });
    queryClient.removeQueries({ queryKey: threadQuery(id).queryKey });
    await refresh();
    closed(false);
  }

  function closed(open: boolean) {
    if (!open) {
      setFailed(undefined);
      onClose();
    }
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
        action="Save"
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
        action="Save"
        maxLength={200}
        initialName={action?.kind === "rename-thread" ? action.thread.title : ""}
        open={action?.kind === "rename-thread"}
        onOpenChange={closed}
        onSubmit={(title) =>
          action?.kind === "rename-thread"
            ? renameThread(action.thread.id, { title })
            : Promise.resolve(undefined)
        }
      />
      <AlertDialog open={action?.kind === "delete-folder"} onOpenChange={closed}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {action?.kind === "delete-folder" ? action.folder.name : "folder"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Its threads move to the top of the space.
            </AlertDialogDescription>
            <FieldError>{failed}</FieldError>
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
      <AlertDialog open={action?.kind === "delete-thread"} onOpenChange={closed}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {action?.kind === "delete-thread" ? action.thread.title : "thread"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Its messages go with it. This cannot be undone.
            </AlertDialogDescription>
            <FieldError>{failed}</FieldError>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (action?.kind === "delete-thread") void deleteThread(action.thread.id);
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
