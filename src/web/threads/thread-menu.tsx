// The thread's "More" menu in its header: the actions the server lets the reader take, each opening
// the dialog that asks what it needs. A subagent's thread, once retired, can be brought back here.

import { useState } from "react";

import type { ThreadCan } from "@/shared/threads/detail.ts";
import type { ThreadSummary } from "@/shared/threads/thread.ts";
import { MoreMenu } from "@/web/components/more-menu";
import { useToast } from "@/web/shell/toaster";
import { MoveThreadDialog } from "@/web/threads/move-thread-dialog";
import { ThreadDialogs, type ThreadAction } from "@/web/threads/thread-dialogs";
import { ThreadMenuItems } from "@/web/threads/thread-menu-items";

export function ThreadMenu({
  thread,
  can,
  archived,
  onUnarchive,
}: {
  thread: ThreadSummary;
  can: ThreadCan;
  // Its space is archived, which is where a thread is moved out of.
  archived: boolean;
  onUnarchive?: () => void;
}) {
  const toast = useToast();
  const [action, setAction] = useState<ThreadAction | null>(null);
  const [moving, setMoving] = useState(false);
  return (
    <>
      <MoreMenu>
        <ThreadMenuItems
          onUnarchive={onUnarchive}
          onRename={can.arrange ? () => setAction({ kind: "rename-thread", thread }) : undefined}
          onMove={archived && can.move ? () => setMoving(true) : undefined}
          onCopyLink={() =>
            void navigator.clipboard
              .writeText(`${window.location.origin}/t/${thread.id}`)
              .then(() => toast("Link copied", "info"))
          }
          onDelete={can.delete ? () => setAction({ kind: "delete-thread", thread }) : undefined}
        />
      </MoreMenu>
      <ThreadDialogs spaceId={thread.spaceId} action={action} onClose={() => setAction(null)} />
      {archived && can.move && (
        <MoveThreadDialog thread={thread} open={moving} onOpenChange={setMoving} />
      )}
    </>
  );
}
