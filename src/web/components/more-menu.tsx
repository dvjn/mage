// The "More" button of an object, a page header or a row, and the menu it opens: what the reader
// may do beyond the controls shown, with a destructive item last, set apart and in red. It is not
// shown with nothing in it. On a row it appears when the row is hovered or focused, and always on
// a touch screen. A page holds one per row, so the button is drawn bare until it is first pressed
// or focused, and only then is the menu mounted, open when a press or a key asked for it.

import { cn } from "cn";
import { EllipsisIcon } from "lucide-react";
import { cloneElement, useState } from "react";
import type { FocusEvent, KeyboardEvent, PointerEvent, ReactElement, ReactNode } from "react";

import { Button } from "@/web/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/web/components/ui/dropdown-menu";
import { useRefocus } from "@/web/hooks/use-refocus";
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
  // How the menu was first reached: a press or key opens it, a focus only readies it.
  const [armed, setArmed] = useState<false | "open" | "focus">(false);
  // Mounting the menu replaces the button, so a focused one takes focus back.
  const ref = useRefocus(armed === "focus");
  if (empty || (!children && !destructive)) return null;

  if (!armed) {
    const own = (trigger?.props ?? {}) as {
      onPointerDown?: (event: PointerEvent<HTMLElement>) => void;
      onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
      onFocus?: (event: FocusEvent<HTMLElement>) => void;
    };
    return (
      <WithTooltip label="More">
        {cloneElement(
          trigger ?? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={name ? `More for ${name}` : "More"}
              className={cn(row && ROW_REVEAL, className)}
            />
          ),
          {
            "aria-haspopup": "menu",
            "aria-expanded": false,
            onPointerDown: (event: PointerEvent<HTMLElement>) => {
              own.onPointerDown?.(event);
              if (event.button === 0 && !event.ctrlKey) {
                event.preventDefault();
                setArmed("open");
              }
            },
            onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
              own.onKeyDown?.(event);
              if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
                event.preventDefault();
                setArmed("open");
              }
            },
            onFocus: (event: FocusEvent<HTMLElement>) => {
              own.onFocus?.(event);
              if (event.currentTarget.matches(":focus-visible")) setArmed("focus");
            },
          } as object,
          <EllipsisIcon />,
        )}
      </WithTooltip>
    );
  }
  return (
    <DropdownMenu defaultOpen={armed === "open"}>
      <WithTooltip label="More">
        <DropdownMenuTrigger
          render={cloneElement(
            trigger ?? (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={name ? `More for ${name}` : "More"}
                className={cn(row && ROW_REVEAL, className)}
              />
            ),
            { ref } as object,
          )}
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
