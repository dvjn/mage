// The dialogs behind the sidebar's thread menus: renaming a thread and deleting it. Deleting the
// open thread leads back to its space. A delete that fails says why in its dialog, which stays
// open.

import { useNavigate, useParams } from "@tanstack/react-router";

import type { ThreadSummary } from "@/shared/threads/thread.ts";
import { ConfirmDialog } from "@/web/components/confirm-dialog";
import { NameDialog } from "@/web/components/name-dialog";
import { useDeleteThread, useRenameThread } from "@/web/threads/mutations";

export type ThreadAction =
  | { kind: "rename-thread"; thread: ThreadSummary }
  | { kind: "delete-thread"; thread: ThreadSummary };

// Whatever `action` is not a thread's opens none of them.
export function ThreadDialogs({
  spaceId,
  action,
  onClose,
}: {
  spaceId: string;
  action: { kind: string } | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { threadId: openThreadId } = useParams({ strict: false });
  const rename = useRenameThread(spaceId);
  const removal = useDeleteThread(spaceId, async (id) => {
    if (id === openThreadId) await navigate({ to: "/s/$spaceId", params: { spaceId } });
  });
  const threadAction = action as ThreadAction | null;

  function closed(open: boolean) {
    if (!open) {
      removal.reset();
      onClose();
    }
  }

  return (
    <>
      <NameDialog
        key={threadAction?.kind === "rename-thread" ? threadAction.thread.id : "rename-thread"}
        title="Rename thread"
        action="Save"
        maxLength={200}
        initialName={threadAction?.kind === "rename-thread" ? threadAction.thread.title : ""}
        open={threadAction?.kind === "rename-thread"}
        onOpenChange={closed}
        onSubmit={(title) =>
          threadAction?.kind === "rename-thread"
            ? rename.mutateAsync({ id: threadAction.thread.id, title }).then(
                () => undefined,
                (failed: Error) => failed.message,
              )
            : Promise.resolve(undefined)
        }
      />
      <ConfirmDialog
        open={threadAction?.kind === "delete-thread"}
        onOpenChange={closed}
        title={`Delete ${threadAction?.kind === "delete-thread" ? threadAction.thread.title : "thread"}?`}
        description="Its messages go with it. This cannot be undone."
        error={removal.error?.message}
        disabled={removal.isPending}
        action="Delete"
        onConfirm={() => {
          if (threadAction?.kind === "delete-thread") {
            removal.mutate(threadAction.thread.id, { onSuccess: () => closed(false) });
          }
        }}
      />
    </>
  );
}
