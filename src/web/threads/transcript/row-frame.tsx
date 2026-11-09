// A row of a thread's transcript: an avatar beside a header with the author and the time, and the
// body flush with the header, with what can be done from it below; a row that continues its
// author's turn is its body alone.

import { type ReactNode } from "react";

import { Time } from "@/web/components/time";

// A row of the transcript: the avatar beside a header with the author and the time, and the body
// flush with the header.
export function TranscriptRowFrame({
  avatar,
  author,
  at,
  label,
  note,
  actions,
  footer,
  continued,
  children,
}: {
  avatar: ReactNode;
  author: string;
  at: string;
  label: string;
  note?: ReactNode;
  // Shown beside the author while the row is hovered or focused.
  actions?: ReactNode;
  // Under the body.
  footer?: ReactNode;
  // Follows another row of the same author's turn: its body alone, under that row's header, with
  // any note of its own above.
  continued?: boolean;
  children: ReactNode;
}) {
  if (continued) {
    return (
      <article aria-label={label} className="group/row relative flex flex-col gap-1 pl-9">
        {note && (
          <div className="flex items-baseline gap-2 text-xs text-muted-foreground">{note}</div>
        )}
        {children}
        {footer}
        {actions && (
          <div className="absolute top-0 right-0 flex items-center gap-2 text-xs text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
            {actions}
          </div>
        )}
      </article>
    );
  }
  return (
    <article aria-label={label} className="group/row flex gap-3">
      <div className="mt-0.5 shrink-0">{avatar}</div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium">{author}</span>
          <Time iso={at} className="text-xs text-muted-foreground" />
          {/* Each note after the time reads as its own item. */}
          {note && (
            <span className="flex items-baseline gap-2 text-xs text-muted-foreground *:before:mr-2 *:before:content-['·']">
              {note}
            </span>
          )}
          {actions && (
            <div className="-my-1 ml-auto flex items-center gap-2 self-center text-xs text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
              {actions}
            </div>
          )}
        </div>
        {children}
        {footer}
      </div>
    </article>
  );
}
