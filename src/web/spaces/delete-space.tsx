// Deleting a space, asking first, the same from every place that offers it: a team org member's
// own space goes to trash with all its threads, and any other is deleted for good once it has
// none. `useSpaceDeletion` gives what a confirm needs; `DeleteSpaceConfirm` is the confirm.

import type * as React from "react";

import { type SpaceSummary, TRASH_DAYS } from "@/shared/spaces.ts";
import { ConfirmDialog } from "@/web/components/confirm-dialog";
import { plural } from "@/web/lib/plural";
import { useDeleteSpace } from "@/web/spaces/mutations";

// Where the space goes and what goes with it, once its threads are counted.
function ownSpaceGoes(threads: number | undefined) {
  const what = threads
    ? ` with ${threads === 1 ? "its thread" : `its ${plural(threads, "thread")}`}`
    : "";
  return `It goes to trash${what} for ${TRASH_DAYS} days.`;
}

export function useSpaceDeletion({
  space,
  own,
  threads,
  leave,
  onDone,
}: {
  space: Pick<SpaceSummary, "id" | "name">;
  // A member's own space, which goes to trash.
  own: boolean;
  // How many threads go with it, once known.
  threads?: number;
  // Takes the person elsewhere once it is gone.
  leave?: () => Promise<void>;
  onDone?: () => void;
}) {
  const remove = useDeleteSpace(leave);
  return {
    confirmTitle: `Delete ${space.name}?`,
    confirmDescription: own ? ownSpaceGoes(threads) : "This cannot be undone.",
    action: "Delete",
    error: remove.error?.message,
    disabled: remove.isPending,
    onOpenChange: () => remove.reset(),
    onConfirm: () => remove.mutate(space.id, { onSuccess: onDone }),
  };
}

export function DeleteSpaceConfirm({
  trigger,
  triggerLabel,
  open,
  onOpenChange,
  ...deletion
}: {
  space: Pick<SpaceSummary, "id" | "name">;
  own: boolean;
  threads?: number;
  leave?: () => Promise<void>;
  // The element that opens it, or the owner holds it open.
  trigger?: React.ReactElement;
  triggerLabel?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const {
    confirmTitle,
    confirmDescription,
    onOpenChange: reset,
    ...rest
  } = useSpaceDeletion({
    ...deletion,
    onDone: () => onOpenChange?.(false),
  });
  return (
    <ConfirmDialog
      {...(trigger && { trigger })}
      triggerLabel={triggerLabel}
      {...(open !== undefined && { open })}
      onOpenChange={(next) => {
        onOpenChange?.(next);
        reset();
      }}
      title={confirmTitle}
      description={confirmDescription}
      {...rest}
    />
  );
}
