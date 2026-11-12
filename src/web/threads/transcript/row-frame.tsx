// Human messages sit on the right with their avatar, and so do notifications, as a card in place
// of the bubble; agent content uses the full left edge. Agent actions stay visible; the controls
// of the right-hand rows appear on hover or focus.

import { cn } from "cn";
import { type PointerEvent, type ReactNode } from "react";

import { rowElementId, useRowFocus, useRowLit } from "@/web/threads/transcript/row-focus";

export function TranscriptRowFrame({
  avatar,
  human = false,
  card = false,
  boxed = false,
  label,
  note,
  actions,
  footer,
  rowId,
  children,
}: {
  avatar?: ReactNode;
  human?: boolean;
  // The content is a card that is the whole bubble, with its own outline, flashed on a highlight.
  card?: boolean;
  // The content is a card with its own outline, which is what a highlight flashes.
  boxed?: boolean;
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
  const highlighted = useRowLit(rowId);
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
        className="group/row flex min-w-0 justify-end gap-2.5"
      >
        <div
          className={cn(
            "relative flex min-w-0 max-w-[85%] flex-col items-end gap-1",
            // An opened card takes the full width its details need, as tool cards do.
            card && "has-data-open:w-full has-data-[state=open]:w-full",
          )}
        >
          <div
            className={cn(
              "min-w-0 max-w-full [overflow-wrap:anywhere]",
              card ? "w-full rounded-lg" : "rounded-2xl bg-muted px-4 py-2.5",
              highlighted && (card ? "attention" : "attention-bubble"),
            )}
          >
            {children}
          </div>
          {(controls || footer) && (
            <div className="flex items-center gap-1 empty:hidden">
              {controls}
              {footer}
            </div>
          )}
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
        // A card is the box that flashes; a bare reply flashes its own faint background.
        highlighted && (boxed ? "attention-card" : "attention-reply"),
      )}
    >
      {note && (
        <div data-slot="row-note" className="flex items-center gap-2 text-xs text-muted-foreground">
          {note}
        </div>
      )}
      {children}
      {(controls || footer) && (
        // The message's actions and its history share one row, with asides at its end.
        <div data-slot="row-controls" className="flex items-center gap-1 empty:hidden">
          {controls}
          {footer}
        </div>
      )}
    </article>
  );
}
