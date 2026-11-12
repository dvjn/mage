// A button that opens a popover, for where a page holds one per row. The button is drawn bare
// until it is first pressed or focused, and only then is the popover mounted, open when a press or
// a key asked for it. With a label it is also named by a tooltip.

import {
  cloneElement,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/web/components/ui/popover";
import { useRefocus } from "@/web/hooks/use-refocus";
import { WithTooltip } from "@/web/components/with-tooltip";

type ControlProps = {
  disabled?: boolean;
  onPointerDown?: (event: PointerEvent<HTMLElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
};

export function LazyPopover({
  trigger,
  label,
  open,
  onOpenChange,
  children,
  ...content
}: {
  // The button, which keeps its own aria-label.
  trigger: ReactElement;
  // Names the button in a tooltip.
  label?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
} & Omit<React.ComponentProps<typeof PopoverContent>, "children">) {
  const [armed, setArmed] = useState<false | "open" | "focus">(false);
  // Mounting the popover replaces the button, so a focused one takes focus back.
  const ref = useRefocus(armed === "focus");
  // Opened from outside, as another control asks for it, it is mounted at once.
  if (open && !armed) setArmed("open");

  const tooltip = (button: ReactElement) =>
    label ? <WithTooltip label={label}>{button}</WithTooltip> : button;

  if (!armed) {
    const own = trigger.props as ControlProps;
    return tooltip(
      cloneElement(trigger, {
        "aria-haspopup": "dialog",
        "aria-expanded": false,
        onPointerDown: (event: PointerEvent<HTMLElement>) => {
          own.onPointerDown?.(event);
          if (event.button === 0 && !event.ctrlKey && !own.disabled) {
            event.preventDefault();
            setArmed("open");
            onOpenChange?.(true);
          }
        },
        onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
          own.onKeyDown?.(event);
          if ((event.key === "Enter" || event.key === " ") && !own.disabled) {
            event.preventDefault();
            setArmed("open");
            onOpenChange?.(true);
          }
        },
        onFocus: (event: FocusEvent<HTMLElement>) => {
          own.onFocus?.(event);
          if (event.currentTarget.matches(":focus-visible")) setArmed("focus");
        },
      } as object),
    );
  }
  return (
    <Popover
      {...(open === undefined ? { defaultOpen: armed === "open" } : { open })}
      {...(onOpenChange && { onOpenChange })}
    >
      {tooltip(<PopoverTrigger render={cloneElement(trigger, { ref } as object)} />)}
      <PopoverContent {...content}>{children}</PopoverContent>
    </Popover>
  );
}
