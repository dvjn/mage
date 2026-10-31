// The dialogs behind the sidebar's folder menus: naming a new folder, renaming one, and deleting
// one. A delete that fails says why in its dialog, which stays open.

import type { FolderSummary } from "@/shared/folders.ts";
import { ConfirmDialog } from "@/web/components/confirm-dialog";
import { NameDialog } from "@/web/components/name-dialog";
import { useCreateFolder, useDeleteFolder, useRenameFolder } from "@/web/folders/mutations";

export type FolderAction =
  | { kind: "new-folder" }
  | { kind: "rename-folder"; folder: FolderSummary }
  | { kind: "delete-folder"; folder: FolderSummary };

// Whatever `action` is not a folder's opens none of them.
export function FolderDialogs({
  spaceId,
  action,
  onClose,
}: {
  spaceId: string;
  action: { kind: string } | null;
  onClose: () => void;
}) {
  const create = useCreateFolder(spaceId);
  const rename = useRenameFolder(spaceId);
  const removal = useDeleteFolder(spaceId);
  const folderAction = action as FolderAction | null;

  // What a name dialog shows: nothing, or why it could not be saved.
  const failure = (pending: Promise<unknown>) =>
    pending.then(
      () => undefined,
      (failed: Error) => failed.message,
    );

  function closed(open: boolean) {
    if (!open) {
      removal.reset();
      onClose();
    }
  }

  return (
    <>
      <NameDialog
        title="New folder"
        action="Create"
        open={folderAction?.kind === "new-folder"}
        onOpenChange={closed}
        onSubmit={(name) => failure(create.mutateAsync(name))}
      />
      <NameDialog
        key={folderAction?.kind === "rename-folder" ? folderAction.folder.id : "rename-folder"}
        title="Rename folder"
        action="Save"
        initialName={folderAction?.kind === "rename-folder" ? folderAction.folder.name : ""}
        open={folderAction?.kind === "rename-folder"}
        onOpenChange={closed}
        onSubmit={(name) =>
          folderAction?.kind === "rename-folder"
            ? failure(rename.mutateAsync({ id: folderAction.folder.id, name }))
            : Promise.resolve(undefined)
        }
      />
      <ConfirmDialog
        open={folderAction?.kind === "delete-folder"}
        onOpenChange={closed}
        title={`Delete ${folderAction?.kind === "delete-folder" ? folderAction.folder.name : "folder"}?`}
        description="Its threads move to the top of the space."
        error={removal.error?.message}
        disabled={removal.isPending}
        action="Delete"
        onConfirm={() => {
          if (folderAction?.kind === "delete-folder") {
            removal.mutate(folderAction.folder.id, { onSuccess: () => closed(false) });
          }
        }}
      />
    </>
  );
}
