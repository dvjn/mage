// What the subscription sign-ins share: opening the provider's page in a new tab,
// and pasting back what the provider showed after the person approved.

import { type FormEvent, useId, useState } from "react";

import { Button } from "@/web/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/web/components/ui/field";
import { Input } from "@/web/components/ui/input";

// Opens a tab before an awaited request so the browser does not block it as a popup.
export async function openInNewTab(url: () => Promise<string | null>) {
  const tab = window.open("", "_blank");
  const target = await url();
  if (!target) {
    tab?.close();
    return;
  }
  if (tab) {
    tab.opener = null;
    tab.location.href = target;
  } else {
    window.open(target, "_blank", "noopener");
  }
}

// Takes the address the browser ended on, or the code, after the user approved.
export function PasteBack({
  label,
  description,
  onSubmit,
}: {
  label: string;
  description: string;
  onSubmit: (pasted: string) => Promise<void>;
}) {
  const id = useId();
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const pasted = new FormData(event.currentTarget).get("callbackUrl");
    setPending(true);
    await onSubmit(typeof pasted === "string" ? pasted : "");
    setPending(false);
  }

  return (
    <form onSubmit={(event) => void submit(event)}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <Input id={id} name="callbackUrl" required autoComplete="off" />
          <FieldDescription>{description}</FieldDescription>
        </Field>
        <Field>
          <Button type="submit" disabled={pending}>
            Connect
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}
