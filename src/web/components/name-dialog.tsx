// Asks for a name, to make or rename a space or a thread, or label an API key, where it
// may be left empty. It opens from its trigger, or
// from its owner when it has no trigger.

import { type FormEvent, type ReactElement, type ReactNode, useId, useState } from "react";

import { Button } from "@/web/components/ui/button";
import { DialogClose, DialogFooter, DialogHeader, DialogTitle } from "@/web/components/ui/dialog";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogTrigger,
} from "@/web/components/responsive-dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/web/components/ui/field";
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
  secret,
  hint,
  extra,
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
  // Hides what is typed, for a secret.
  secret?: boolean;
  // One line under the field.
  hint?: string;
  // A button at the start of the footer, for a way out of what the field sets; given `settle`, it
  // runs its own work as the form does, and `pending` while either runs.
  extra?:
    | ReactNode
    | ((settle: (work: () => Promise<string | undefined>) => void, pending: boolean) => ReactNode);
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

  // Runs the work, its error shown and the dialog left open when it fails, closed when it is done.
  async function settle(work: () => Promise<string | undefined>) {
    setPending(true);
    const failed = await work();
    setPending(false);
    setError(failed);
    if (!failed) setOpen(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get("name");
    await settle(async () => onSubmit(typeof name === "string" ? name : ""));
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setError(undefined);
      }}
    >
      {trigger && <ResponsiveDialogTrigger render={trigger} />}
      <ResponsiveDialogContent>
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
                {...(secret && { type: "password" })}
              />
              {hint && <FieldDescription>{hint}</FieldDescription>}
              <FieldError>{error}</FieldError>
            </Field>
          </FieldGroup>
          <DialogFooter>
            {typeof extra === "function" ? extra((work) => void settle(work), pending) : extra}
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button type="submit" disabled={pending}>
              {action}
            </Button>
          </DialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
