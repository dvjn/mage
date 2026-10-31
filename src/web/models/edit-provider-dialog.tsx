// Changes a provider connection in a dialog of its own, with the fields it was added with, filled
// in with its settings.

import { type FormEvent, useId, useState } from "react";

import { type ConnectionSummary, connectionLabel } from "@/shared/connections.ts";
import { hostOf, methodOf } from "@/shared/hosts.ts";
import { HostMark } from "@/web/models/marks";
import { Button } from "@/web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/web/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/web/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/web/components/ui/select";
import { LabelField, MethodFields, missingIn, storedValues } from "@/web/models/provider-fields";
import { useEditConnection } from "@/web/models/mutations";

// Changing a connection that is not a sign-in: its label, the way it connects where its host has
// more than one, and that way's fields. Saving checks them by reading its models again.
export function EditProviderDialog({
  connection,
  open,
  onOpenChange,
}: {
  connection: ConnectionSummary | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {connection && connection.authKind !== "oauth" && (
          <EditProviderForm
            key={connection.id}
            connection={connection}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditProviderForm({
  connection,
  onDone,
}: {
  connection: ConnectionSummary;
  onDone: () => void;
}) {
  const id = useId();
  const methods = hostOf(connection.host).methods.filter((method) => method.authKind !== "oauth");
  const [methodId, setMethodId] = useState(
    () =>
      methodOf(connection.host, connection.settings.method, connection.authKind)?.id ??
      methods[0]!.id,
  );
  const method = methods.find((found) => found.id === methodId) ?? methods[0]!;
  const [values, setValues] = useState(() => storedValues(connection, methods));
  const [label, setLabel] = useState(connection.label ?? "");
  const edit = useEditConnection(connection.id);
  const missing = missingIn(method, values, connection.hints);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    edit.mutate(
      {
        method: method.id,
        label: label.trim() || null,
        values: Object.fromEntries(
          method.fields.map((field) => [field.name, values[field.name] ?? ""]),
        ),
      },
      { onSuccess: onDone },
    );
  }

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-2">
          <HostMark host={connection.host} />
          <DialogTitle>Edit {connectionLabel(connection)}</DialogTitle>
        </div>
        <DialogDescription>
          Secrets left blank keep the ones stored. Saving checks the details by reading its models
          again.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={submit}>
        <FieldGroup>
          <LabelField id={id} value={label} onChange={setLabel} />
          {methods.length > 1 && (
            <Field>
              <FieldLabel htmlFor={`${id}-method`}>Connects with</FieldLabel>
              <Select
                value={method.id}
                onValueChange={(next) => setMethodId(String(next ?? method.id))}
              >
                <SelectTrigger id={`${id}-method`} className="w-full">
                  <SelectValue>{method.title}</SelectValue>
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  {methods.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>{method.description}</FieldDescription>
            </Field>
          )}
          <MethodFields
            id={id}
            method={method}
            values={values}
            onChange={setValues}
            hints={connection.hints}
            autoFocus={false}
          />
          <FieldError>{edit.error?.message}</FieldError>
        </FieldGroup>
        <DialogFooter className="mt-4">
          <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
          <Button type="submit" disabled={edit.isPending || missing}>
            {edit.isPending ? "Checking…" : "Save"}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
