// The org's switch for whether its spaces may add their own of something beside the org's.

import { useId } from "react";

import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/web/components/ui/field";
import { Switch } from "@/web/components/ui/switch";

export function ExtensionSwitch({
  label,
  description,
  allowed,
  canManage,
  pending = false,
  error,
  onChange,
}: {
  label: string;
  description: string;
  allowed: boolean;
  canManage: boolean;
  // A change is on its way; the switch waits for it.
  pending?: boolean;
  error?: string;
  onChange: (allowed: boolean) => void;
}) {
  const id = useId();
  return (
    <Field orientation="horizontal" className="border-t pt-4">
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <FieldDescription>{description}</FieldDescription>
        <FieldError>{error}</FieldError>
      </FieldContent>
      <Switch
        id={id}
        checked={allowed}
        disabled={!canManage || pending}
        onCheckedChange={onChange}
      />
    </Field>
  );
}
