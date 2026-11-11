// Human messages sit on the right with their avatar; agent content and notifications use the
// full left edge. Agent actions stay visible; human Copy/Edit controls appear on hover or focus.

import { cn } from "cn";
import { type PointerEvent, type ReactNode } from "react";

import { rowElementId, useRowFocus } from "@/web/threads/transcript/row-focus";

export function TranscriptRowFrame({
  avatar,
  human = false,
  outlined = false,
  label,
  note,
  actions,
  footer,
  rowId,
  children,
}: {
  avatar?: ReactNode;
  human?: boolean;
  outlined?: boolean;
  author: ReactNode;
  at?: string;
  label: string;
  note?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  continued?: boolean;
  rowId?: string;
  children: ReactNode;
}) {
  const focus = useRowFocus();
  const highlighted = !!rowId && focus?.lit === rowId;
  const attributes = {
    ...(rowId && { id: rowElementId(rowId) }),
    "data-lit": highlighted || undefined,
    tabIndex: human ? 0 : undefined,
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      if (rowId && event.pointerType !== "touch") focus?.dismiss?.(rowId);
    },
    onPointerDownCapture: () => {
      if (rowId) focus?.dismiss?.(rowId);
    },
    onKeyDownCapture: () => {
      if (rowId) focus?.dismiss?.(rowId);
    },
  };
  const controls = actions && (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1 text-xs text-muted-foreground",
        human &&
          "pointer-events-none opacity-0 transition-opacity group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100 has-[[aria-expanded=true]]:pointer-events-auto has-[[aria-expanded=true]]:opacity-100",
      )}
    >
      {actions}
    </div>
  );
  if (human) {
    return (
      <article
        {...attributes}
        aria-label={label}
        className={cn("group/row flex min-w-0 justify-end gap-2.5", highlighted && "row-attention")}
      >
        <div className="relative flex min-w-0 max-w-[85%] flex-col items-end gap-1">
          <div
            className={cn(
              "min-w-0 max-w-full rounded-2xl px-4 py-2.5 [overflow-wrap:anywhere]",
              outlined ? "relative" : "bg-muted",
            )}
          >
            {outlined && (
              // Drawn rather than a dashed border, whose dashes the browser sizes.
              <svg
                aria-hidden
                className="pointer-events-none absolute inset-0 size-full overflow-visible text-muted-foreground/30"
              >
                <rect
                  x="0.5"
                  y="0.5"
                  rx="15.5"
                  fill="none"
                  stroke="currentColor"
                  strokeDasharray="6 4"
                  style={{ width: "calc(100% - 1px)", height: "calc(100% - 1px)" }}
                />
              </svg>
            )}
            {children}
          </div>
          {controls}
          {footer}
        </div>
        <div className="mt-0.5 shrink-0">{avatar}</div>
      </article>
    );
  }
  return (
    <article
      {...attributes}
      aria-label={label}
      className={cn(
        "group/row flex min-w-0 flex-col gap-1 [overflow-wrap:anywhere]",
        highlighted && "row-attention",
      )}
    >
      {note && <div className="flex items-center gap-2 text-xs text-muted-foreground">{note}</div>}
      {children}
      {controls}
      {footer}
    </article>
  );
}
