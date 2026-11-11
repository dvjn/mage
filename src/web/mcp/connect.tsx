// Connecting one's own credentials for a server whose people each bring theirs: signing in with
// it, the browser coming back to a page of Mage, or giving one's own value for each header it is
// sent, in a dialog. Something that needs the connection, such as allowing a call, follows once it
// is made: at once after header values are saved or the sign-in still held, or on the page the
// browser comes back to, which the caller names.

import { type ComponentProps, type FormEvent, type ReactNode, useId, useState } from "react";

import { Button } from "@/web/components/ui/button";
import {
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/web/components/ui/dialog";
import { ResponsiveDialog, ResponsiveDialogContent } from "@/web/components/responsive-dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/web/components/ui/field";
import { Input } from "@/web/components/ui/input";
import { useConnect } from "@/web/mcp/mutations";
import { useToast } from "@/web/shell/toaster";

// The server to connect to: its name, and how one connects.
export interface Connectable {
  serverId: string;
  title: string;
  kind: "oauth" | "headers";
  headers: string[];
}

// What a header's field is called; the Authorization header takes a bearer token.
function fieldLabel(name: string) {
  return name === "authorization" ? "Bearer token" : name;
}

// The way to connect to a server: `start` opens the header dialog or signs in, then runs `after`
// once connected; a sign-in that leaves the page comes back to `returnTo` instead, which then does
// what `after` would. `dialog` goes wherever the caller renders.
export function useConnectFlow(connection: Connectable | undefined) {
  const { headers, oauth } = useConnect();
  const toast = useToast();
  const [then, setThen] = useState<{ run?: () => Promise<void> } | null>(null);
  const [busy, setBusy] = useState(false);

  async function start(after?: () => Promise<void>, returnTo?: string) {
    if (!connection) return;
    if (connection.kind === "headers") {
      setThen({ run: after });
      return;
    }
    setBusy(true);
    try {
      await oauth.mutateAsync({ serverId: connection.serverId, returnTo });
      await after?.();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const dialog: ReactNode = connection?.kind === "headers" && (
    <HeadersDialog
      connection={connection}
      open={!!then}
      onOpenChange={(next) => {
        if (next) return;
        setThen(null);
        headers.reset();
      }}
      save={async (values) => {
        await headers.mutateAsync({ serverId: connection.serverId, values });
        const after = then?.run;
        setThen(null);
        await after?.();
      }}
      pending={headers.isPending}
      error={headers.error?.message}
    />
  );

  return { start, busy: busy || oauth.isPending, dialog };
}

export function ConnectButton({
  connection,
  label = "Connect",
  ...props
}: {
  connection: Connectable;
  label?: string;
} & Omit<ComponentProps<typeof Button>, "onClick" | "children">) {
  const flow = useConnectFlow(connection);
  return (
    <>
      <Button {...props} disabled={props.disabled || flow.busy} onClick={() => void flow.start()}>
        {label}
      </Button>
      {flow.dialog}
    </>
  );
}

function HeadersDialog({
  connection,
  open,
  onOpenChange,
  save,
  pending,
  error,
}: {
  connection: Connectable;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  save: (values: { name: string; value: string }[]) => Promise<void>;
  pending: boolean;
  error: string | undefined;
}) {
  const id = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const missing = connection.headers.some((name) => !values[name]?.trim());

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void save(
      connection.headers.map((name) => {
        const value = values[name]!.trim();
        return { name, value: name === "authorization" ? `Bearer ${value}` : value };
      }),
    )
      .then(() => setValues({}))
      .catch(() => {});
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connect to {connection.title}</DialogTitle>
          <DialogDescription>Only your calls use these.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <FieldGroup>
            {connection.headers.map((name, index) => (
              <Field key={name}>
                <FieldLabel htmlFor={`${id}-${index}`}>{fieldLabel(name)}</FieldLabel>
                <Input
                  id={`${id}-${index}`}
                  type="password"
                  value={values[name] ?? ""}
                  onChange={(event) => setValues({ ...values, [name]: event.target.value })}
                  autoComplete="off"
                  autoFocus={index === 0}
                />
              </Field>
            ))}
            <FieldError>{error}</FieldError>
          </FieldGroup>
          <DialogFooter className="mt-4">
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button type="submit" disabled={pending || missing}>
              {pending ? "Connecting…" : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
