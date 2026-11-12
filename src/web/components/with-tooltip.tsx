// A tooltip naming an icon-only control, with its shortcut where it has one. A page holds hundreds
// of these, so they share one tooltip, mounted once by SharedTooltip: each control is only a
// trigger that tells it what to say.

import * as React from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";

import { Kbd } from "@/web/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/web/components/ui/tooltip";
import { shortcutHint, type ShortcutId } from "@/web/lib/shortcuts";

type Say = { label: string; shortcut?: ShortcutId | undefined };

const tooltip = TooltipPrimitive.createHandle<Say>();

// The one tooltip every WithTooltip control opens; mount it once, at the app's root.
export function SharedTooltip() {
  return (
    <Tooltip handle={tooltip}>
      {({ payload }) => (
        <TooltipContent>
          {payload?.label}
          {payload?.shortcut && <Kbd>{shortcutHint(payload.shortcut)}</Kbd>}
        </TooltipContent>
      )}
    </Tooltip>
  );
}

export function WithTooltip({
  label,
  shortcut,
  children,
}: {
  label: string;
  shortcut?: ShortcutId;
  // The control, which keeps its own aria-label.
  children: React.ReactElement;
}) {
  return <TooltipTrigger handle={tooltip} payload={{ label, shortcut }} render={children} />;
}
