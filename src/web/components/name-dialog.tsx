// Asks for a name, to make or rename a space or a thread, or label an API key, where it
// may be left empty. It opens from its trigger, or
// from its owner when it has no trigger.

import { type FormEvent, type ReactElement, useId, useState } from "react";

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
import { Input } from "@/web/components/ui/input";

export function NameDialog({
  trigger,
  open: openProp,
  onOpenChange,
  title,
  action,
  initialName = "",
  maxLength = 80,
  label = "Name",
  required = true,
  onSubmit,
}: {
  trigger?: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: string;
  action: string;
  initialName?: string;
  maxLength?: number;
  label?: string;
  required?: boolean;
  // Resolves to an error to show, or nothing when done.
  onSubmit: (name: string) => Promise<string | undefined>;
}) {
  const id = useId();
  const [ownOpen, setOwnOpen] = useState(false);
  const open = openProp ?? ownOpen;

  function setOpen(next: boolean) {
    setOwnOpen(next);
    onOpenChange?.(next);
  }
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get("name");
    setPending(true);
    const failed = await onSubmit(typeof name === "string" ? name : "");
    setPending(false);
    setError(failed);
    if (!failed) setOpen(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setError(undefined);
      }}
    >
      {trigger && <DialogTrigger render={trigger} />}
      <DialogContent>
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel htmlFor={id}>{label}</FieldLabel>
              <Input
                id={id}
                name="name"
                defaultValue={initialName}
                required={required}
                maxLength={maxLength}
                autoComplete="off"
              />
              <FieldError>{error}</FieldError>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button type="submit" disabled={pending}>
              {action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
