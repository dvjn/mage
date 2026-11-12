// A router link that opens on press start, as a native app's rows do: a primary-button mouse or
// pen press with no modifier key follows the link at once, and the click that ends the press is
// dropped. Keyboard, touch (which must stay free to scroll), middle and modifier clicks and links
// that open elsewhere keep the browser's click. It also preloads its route when pointed at or
// focused.

import { createLink, type LinkComponent } from "@tanstack/react-router";
import * as React from "react";

const Anchor = React.forwardRef<HTMLAnchorElement, React.ComponentPropsWithoutRef<"a">>(
  ({ onClick, onPointerDown, ...props }, ref) => {
    // A press already followed, whose click is still to come.
    const pressed = React.useRef(false);
    // The click this component makes itself, which must go through.
    const firing = React.useRef(false);
    return (
      <a
        ref={ref}
        {...props}
        onPointerDown={(event) => {
          onPointerDown?.(event);
          pressed.current = false;
          const link = event.currentTarget;
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            !event.isPrimary ||
            event.pointerType === "touch" ||
            event.metaKey ||
            event.altKey ||
            event.ctrlKey ||
            event.shiftKey ||
            link.hasAttribute("download") ||
            (link.target && link.target !== "_self") ||
            link.getAttribute("aria-disabled") === "true"
          ) {
            return;
          }
          pressed.current = true;
          firing.current = true;
          try {
            link.click();
          } finally {
            firing.current = false;
          }
        }}
        onClick={(event) => {
          if (!firing.current && pressed.current && event.detail > 0) {
            pressed.current = false;
            event.preventDefault();
            return;
          }
          onClick?.(event);
        }}
      />
    );
  },
);
Anchor.displayName = "PressAnchor";

const Created = createLink(Anchor);

export const PressLink: LinkComponent<typeof Anchor> = (props) => (
  <Created preload="intent" {...props} />
);
