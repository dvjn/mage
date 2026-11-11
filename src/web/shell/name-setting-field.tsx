// A name in settings, saved with the one Save that appears once it is changed: an organization's,
// a space's, or the agent's in either. Those who may not change it read it.

import { type FormEvent, useId, useState } from "react";

import { Field, FieldError, FieldGroup, FieldLabel } from "@/web/components/ui/field";
import { Input } from "@/web/components/ui/input";
import { SaveBar } from "@/web/shell/save-bar";

export function NameSettingField({
  label,
  saved,
  onSave,
  pending,
  error,
  maxLength,
  placeholder,
  optional,
  readOnly,
}: {
  // What it is called, "<Thing> name".
  label: string;
  saved: string;
  // The name, trimmed.
  onSave: (name: string) => void;
  pending?: boolean;
  error?: string | undefined;
  maxLength: number;
  // Shown while it is empty.
  placeholder?: string | undefined;
  // It may be left empty.
  optional?: boolean;
  readOnly?: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState(saved);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSave(draft.trim());
  }

  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <Input
            id={id}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={maxLength}
            required={!optional}
            disabled={readOnly}
            placeholder={placeholder}
            autoComplete="off"
          />
        </Field>
        <FieldError>{error}</FieldError>
        {!readOnly && (
          <SaveBar
            dirty={draft.trim() !== saved}
            pending={pending}
            disabled={!optional && !draft.trim()}
          />
        )}
      </FieldGroup>
    </form>
  );
}
