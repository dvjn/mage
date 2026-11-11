// The "More" button of an object, a page header or a row, and the menu it opens: what the reader
// may do beyond the controls shown, with a destructive item last, set apart and in red. It is not
// shown with nothing in it. On a row it appears when the row is hovered or focused, and always on
// a touch screen.

import { cn } from "cn";
import { EllipsisIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { Button } from "@/web/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/web/components/ui/dropdown-menu";
import { WithTooltip } from "@/web/components/with-tooltip";

// Shows a row's menu on the row's hover or focus; the row has the `group` class.
export const ROW_REVEAL =
  "group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 pointer-fine:opacity-0";

export function MoreMenu({
  children,
  destructive,
  empty,
  name,
  row,
  className,
  trigger,
  side,
  align = "end",
}: {
  children?: ReactNode;
  // The destructive item, last.
  destructive?: ReactNode;
  // Set when there is nothing to offer.
  empty?: boolean;
  // The object the menu is for, where there are many on the page.
  name?: string;
  // On a row, revealed by the row.
  row?: boolean;
  className?: string;
  // The button, where the surface has its own kind of it, which names itself.
  trigger?: ReactElement;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
}) {
  if (empty || (!children && !destructive)) return null;
  return (
    <DropdownMenu>
      <WithTooltip label="More">
        <DropdownMenuTrigger
          render={
            trigger ?? (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={name ? `More for ${name}` : "More"}
                className={cn(row && ROW_REVEAL, className)}
              />
            )
          }
        >
          <EllipsisIcon />
        </DropdownMenuTrigger>
      </WithTooltip>
      <DropdownMenuContent
        align={align}
        {...(side && { side })}
        className="w-auto min-w-40 [&_[data-slot=dropdown-menu-item]]:whitespace-nowrap"
      >
        {children}
        {destructive && children && <DropdownMenuSeparator />}
        {destructive}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
