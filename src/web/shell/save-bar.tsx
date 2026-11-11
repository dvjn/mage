// What follows an edited field in settings: a note of the caller's (what went wrong, or that it
// saved), and, once the field differs from what was saved, Discard where given and Save, at the
// one size every settings form uses.

import type * as React from "react";

import { Button } from "@/web/components/ui/button";

export function SaveBar({
  dirty,
  pending,
  disabled,
  onSave,
  onDiscard,
  children,
}: {
  dirty: boolean;
  pending?: boolean;
  // Save cannot be done as it stands.
  disabled?: boolean;
  // Without it, Save submits the form around it.
  onSave?: () => void;
  onDiscard?: () => void;
  children?: React.ReactNode;
}) {
  if (!dirty && !children) return null;
  return (
    <div className="flex items-center gap-2">
      {children}
      <span className="flex-1" />
      {dirty && onDiscard && (
        <Button type="button" variant="ghost" onClick={onDiscard}>
          Discard
        </Button>
      )}
      {dirty && (
        <Button
          type={onSave ? "button" : "submit"}
          disabled={pending || disabled}
          {...(onSave && { onClick: onSave })}
        >
          Save
        </Button>
      )}
    </div>
  );
}
