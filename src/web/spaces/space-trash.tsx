// The org's members' spaces in trash that the person may see, those they deleted or, for its
// owners, all of them: each with its threads and when it went there, to restore or delete for good.

import { EmptyState } from "@/web/components/page-states";
import { useQuery } from "@tanstack/react-query";
import type * as React from "react";

import { TRASH_DAYS, type TrashedSpaceSummary } from "@/shared/spaces.ts";
import { ConfirmDialog } from "@/web/components/confirm-dialog";
import { Time } from "@/web/components/time";
import { Button } from "@/web/components/ui/button";
import { DialogDescription, DialogHeader, DialogTitle } from "@/web/components/ui/dialog";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogTrigger,
} from "@/web/components/responsive-dialog";
import { FieldError } from "@/web/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/web/components/ui/item";
import { plural } from "@/web/lib/plural";
import { usePurgeSpace, useRestoreSpace } from "@/web/spaces/mutations";
import { spaceTrashQuery } from "@/web/spaces/queries";

function TrashedSpace({ space }: { space: TrashedSpaceSummary }) {
  const restore = useRestoreSpace();
  const purge = usePurgeSpace();
  return (
    <Item variant="outline" size="sm" role="listitem" aria-label={space.name}>
      <ItemContent className="min-w-0">
        <ItemTitle className="w-full truncate">{space.name}</ItemTitle>
        <ItemDescription>
          {plural(space.threadCount, "thread")} · deleted <Time iso={space.trashedAt} />
          {space.trashedByName && ` by ${space.trashedByName}`}
        </ItemDescription>
        <FieldError>{restore.error?.message}</FieldError>
      </ItemContent>
      <ItemActions>
        <Button
          variant="outline"
          size="sm"
          disabled={restore.isPending}
          onClick={() => restore.mutate(space.id)}
        >
          Restore
        </Button>
        <ConfirmDialog
          trigger={<Button variant="ghost" size="sm" />}
          triggerLabel="Delete"
          onOpenChange={() => purge.reset()}
          title={`Delete ${space.name} for good?`}
          description="This cannot be undone."
          error={purge.error?.message}
          action="Delete"
          disabled={purge.isPending}
          onConfirm={() => purge.mutate(space.id)}
        />
      </ItemActions>
    </Item>
  );
}

export function SpaceTrash({
  open,
  onOpenChange,
  trigger,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  // The element that opens it, when nothing else holds it open.
  trigger?: React.ReactElement;
}) {
  const trash = useQuery(spaceTrashQuery);
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      {trigger && <ResponsiveDialogTrigger render={trigger}>Trash</ResponsiveDialogTrigger>}
      <ResponsiveDialogContent>
        <DialogHeader>
          <DialogTitle>Trash</DialogTitle>
          <DialogDescription>Deleted for good after {TRASH_DAYS} days.</DialogDescription>
        </DialogHeader>
        {trash.data?.length === 0 ? (
          <EmptyState compact title="Nothing in trash" />
        ) : (
          <ItemGroup aria-label="Trash">
            {trash.data?.map((space) => (
              <TrashedSpace key={space.id} space={space} />
            ))}
          </ItemGroup>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
