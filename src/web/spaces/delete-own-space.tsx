// Puts a team org member's own space in trash with all its threads, asking first.

import { useNavigate } from "@tanstack/react-router";
import type * as React from "react";

import { type SpaceSummary, TRASH_DAYS } from "@/shared/spaces.ts";
import { ConfirmDialog } from "@/web/components/confirm-dialog";
import { plural } from "@/web/lib/plural";
import { useDeleteSpace } from "@/web/spaces/mutations";

// Where the space goes and what goes with it, once its threads are counted.
export function ownSpaceGoes(threads: number | undefined) {
  const what = threads
    ? ` with ${threads === 1 ? "its thread" : `its ${plural(threads, "thread")}`}`
    : "";
  return `It goes to trash${what} for ${TRASH_DAYS} days.`;
}

export function DeleteOwnSpace({
  space,
  threads,
  trigger,
  children,
}: {
  space: SpaceSummary;
  // How many threads go with it, once known.
  threads?: number;
  trigger: React.ReactElement;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const remove = useDeleteSpace(() => navigate({ to: "/" }));
  return (
    <ConfirmDialog
      trigger={trigger}
      triggerLabel={children}
      onOpenChange={() => remove.reset()}
      title={`Delete ${space.name}?`}
      description={ownSpaceGoes(threads)}
      error={remove.error?.message}
      action="Delete"
      disabled={remove.isPending}
      onConfirm={() => remove.mutate(space.id)}
    />
  );
}
