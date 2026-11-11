// A labelled switch in a settings card: what it turns on, a line about it, and the switch beside
// them. Its surroundings, a border or none, are the caller's.

import { useId } from "react";

import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/web/components/ui/field";
import { Switch } from "@/web/components/ui/switch";

export function SettingsSwitch({
  label,
  description,
  checked,
  disabled = false,
  error,
  onChange,
  className,
}: {
  label: string;
  description: string;
  checked: boolean;
  // It cannot be changed now: not by this reader, or a change is on its way.
  disabled?: boolean;
  error?: string | undefined;
  onChange: (checked: boolean) => void;
  className?: string;
}) {
  const id = useId();
  return (
    <Field orientation="horizontal" {...(className && { className })}>
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <FieldDescription>{description}</FieldDescription>
        <FieldError>{error}</FieldError>
      </FieldContent>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </Field>
  );
}
