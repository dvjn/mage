// What a person may still do with a thread of their own archived space: move it to a space where
// they can post, or delete it.

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRightLeftIcon, Trash2Icon } from "lucide-react";
import { useId, useState } from "react";

import type { ThreadSummary } from "@/shared/threads/thread.ts";
import { ConfirmDialog } from "@/web/components/confirm-dialog";
import { Button } from "@/web/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/web/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/web/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/web/components/ui/select";
import { spacesQuery } from "@/web/spaces/queries";
import { useDeleteThread, useMoveThreadToSpace } from "@/web/threads/mutations";

function MoveThread({ thread }: { thread: ThreadSummary }) {
  const id = useId();
  const spaces = useQuery(spacesQuery);
  const move = useMoveThreadToSpace(thread);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  const targets = (spaces.data ?? []).filter(
    (space) =>
      !space.archived &&
      space.id !== thread.spaceId &&
      (space.role === "owner" || space.role === "messager"),
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        move.reset();
      }}
    >
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <ArrowRightLeftIcon />
        Move
      </DialogTrigger>
      <DialogContent>
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
            onClick={() => target && move.mutate(target, { onSuccess: () => setOpen(false) })}
          >
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteThread({ thread }: { thread: ThreadSummary }) {
  const navigate = useNavigate();
  const removal = useDeleteThread(thread.spaceId, () =>
    navigate({ to: "/s/$spaceId", params: { spaceId: thread.spaceId } }),
  );
  return (
    <ConfirmDialog
      trigger={<Button variant="outline" size="sm" />}
      triggerLabel={
        <>
          <Trash2Icon />
          Delete
        </>
      }
      onOpenChange={() => removal.reset()}
      title={`Delete ${thread.title}?`}
      description="This cannot be undone."
      error={removal.error?.message}
      action="Delete"
      disabled={removal.isPending}
      onConfirm={() => removal.mutate(thread.id)}
    />
  );
}

export function ArchivedThreadActions({ thread }: { thread: ThreadSummary }) {
  return (
    <div className="flex items-center gap-2 px-4">
      <MoveThread thread={thread} />
      <DeleteThread thread={thread} />
    </div>
  );
}
