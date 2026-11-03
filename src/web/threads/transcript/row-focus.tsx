// Which of a thread's rows the reader opened, held by its page so that they stay open as rows
// arrive, and the row a link led to, lit for a moment; and links that lead to a row of a thread.

import { Link } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext } from "react";

export interface RowFocus {
  opened: ReadonlySet<string>;
  onOpenChange: (ids: string[], open: boolean) => void;
  // The row a link led to, while it is lit.
  lit?: string;
}

export const RowFocusContext = createContext<RowFocus | null>(null);

export function useRowFocus() {
  return useContext(RowFocusContext);
}

// What a tool call's line is held open by, apart from the run of calls it is in.
export const lineKey = (id: string) => `line:${id}`;

// What a run of other agents' messages is held open by, for each of its messages.
export const relayRunKey = (id: string) => `run:${id}`;

// The element a row shows as, which a link to the row scrolls to.
export const rowElementId = (id: string) => `row-${id}`;

// A link to the thread, at the row when given.
export function RowLink({
  threadId,
  rowId,
  className,
  children,
}: {
  threadId: string;
  rowId?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      to="/t/$threadId"
      params={{ threadId }}
      search={rowId ? { row: rowId } : {}}
      className={className}
    >
      {children}
    </Link>
  );
}
