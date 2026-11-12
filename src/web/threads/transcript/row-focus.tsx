// Which of a thread's rows the reader opened, held by its page so that they stay open as rows
// arrive, and the row a link led to, marked briefly or until the reader interacts with it;
// and links that lead to a row of a thread.

import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext } from "react";

export interface RowFocus {
  opened: ReadonlySet<string>;
  onOpenChange: (ids: string[], open: boolean) => void;
  // The row a link led to: shown for at least two seconds, up to five without interaction.
  lit?: string;
  // The rows whose cards are open in the activity tray, which stay marked while they are.
  held?: ReadonlySet<string>;
  dismiss?: (rowId: string) => void;
  // Leads to the row in the address again, for a link to where the page already is.
  follow?: () => void;
}

export const RowFocusContext = createContext<RowFocus | null>(null);

export function useRowFocus() {
  return useContext(RowFocusContext);
}

// Whether the row is marked: a link led to it, or its card is open in the tray.
export function useRowLit(rowId: string | undefined) {
  const focus = useRowFocus();
  return !!rowId && (focus?.lit === rowId || !!focus?.held?.has(rowId));
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
  label,
  onNavigate,
  children,
}: {
  threadId: string;
  rowId?: string;
  className?: string;
  label?: string;
  // Called when the link is followed, for what must close as the reader leaves.
  onNavigate?: () => void;
  children: ReactNode;
}) {
  const focus = useRowFocus();
  const here = useLocation({
    select: (location) =>
      !!rowId &&
      location.pathname === `/t/${threadId}` &&
      (location.search as { row?: string }).row === rowId,
  });
  return (
    <Link
      to="/t/$threadId"
      params={{ threadId }}
      search={rowId ? { row: rowId } : {}}
      className={className}
      aria-label={label}
      onClick={
        here || onNavigate
          ? () => {
              if (here) focus?.follow?.();
              onNavigate?.();
            }
          : undefined
      }
    >
      {children}
    </Link>
  );
}

// Goes to the row of the thread in the address, scrolling to it and marking it, where the thread is
// already open as well.
export function useGoToRow(threadId: string) {
  const focus = useRowFocus();
  const navigate = useNavigate();
  const row = useLocation({
    select: (location) =>
      location.pathname === `/t/${threadId}`
        ? (location.search as { row?: string }).row
        : undefined,
  });
  return (rowId: string) => {
    if (row === rowId) focus?.follow?.();
    else void navigate({ to: "/t/$threadId", params: { threadId }, search: { row: rowId } });
  };
}
