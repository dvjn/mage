// A tooltip naming an icon-only control, with its shortcut where it has one.

import type * as React from "react";

import { Kbd } from "@/web/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/web/components/ui/tooltip";
import { shortcutHint, type ShortcutId } from "@/web/lib/shortcuts";

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
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent>
        {label}
        {shortcut && <Kbd>{shortcutHint(shortcut)}</Kbd>}
      </TooltipContent>
    </Tooltip>
  );
}
