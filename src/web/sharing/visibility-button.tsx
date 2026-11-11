// The icon-only button that opens a share surface, its icon and tooltip saying who can see the
// thread or artifact now.

import type * as React from "react";

import { Button } from "@/web/components/ui/button";
import { WithTooltip } from "@/web/components/with-tooltip";

export interface Visibility {
  icon: React.ComponentType<{ className?: string }>;
  // Who can see it, as the tooltip says.
  label: string;
}

// Meant as the trigger of a dialog or sheet, which gives it its props.
export function VisibilityButton({
  icon: Icon,
  label,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "children"> & Visibility) {
  return (
    <WithTooltip label={label}>
      <Button size="icon-sm" variant="ghost" aria-label="Share" {...props}>
        <Icon />
      </Button>
    </WithTooltip>
  );
}
