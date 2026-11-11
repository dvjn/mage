// The dialog that moves a thread to a space where the reader can post, opened by the thread's menu.

import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";

import type { ThreadSummary } from "@/shared/threads/thread.ts";
import { Button } from "@/web/components/ui/button";
import { DialogClose, DialogFooter, DialogHeader, DialogTitle } from "@/web/components/ui/dialog";
import { ResponsiveDialog, ResponsiveDialogContent } from "@/web/components/responsive-dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/web/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/web/components/ui/select";
import { spacesQuery } from "@/web/spaces/queries";
import { useMoveThreadToSpace } from "@/web/threads/mutations";

export function MoveThreadDialog({
  thread,
  open,
  onOpenChange,
}: {
  thread: ThreadSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const id = useId();
  const spaces = useQuery(spacesQuery);
  const move = useMoveThreadToSpace(thread);
  const [target, setTarget] = useState<string | null>(null);
  const targets = (spaces.data ?? []).filter((space) => space.post && space.id !== thread.spaceId);

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        move.reset();
      }}
    >
      <ResponsiveDialogContent>
        <DialogHeader>
          <DialogTitle>Move thread</DialogTitle>
        </DialogHeader>
        <FieldGroup className="py-4">
          <Field>
            <FieldLabel htmlFor={id}>Space</FieldLabel>
            <Select value={target} onValueChange={(next) => setTarget(next as string | null)}>
              <SelectTrigger id={id}>
                <SelectValue placeholder="Pick a space">
                  {(value: string | null) => targets.find((space) => space.id === value)?.name}
                </SelectValue>
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                {targets.map((space) => (
                  <SelectItem key={space.id} value={space.id}>
                    {space.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError>{move.error?.message}</FieldError>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button
            disabled={!target || move.isPending}
            onClick={() => target && move.mutate(target, { onSuccess: () => onOpenChange(false) })}
          >
            Move
          </Button>
        </DialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
