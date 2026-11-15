// What a reader may do with tool calls that run in the background: move a call that is running or
// waiting for a decision there, from where it shows, once it has run for a moment; and stop one
// that runs there.

import { ArrowDownToLineIcon, SquareIcon } from "lucide-react";
import { createContext, useContext, useEffect, useState } from "react";

import type { ToolRow } from "@/shared/threads/rows.ts";
import { Button } from "@/web/components/ui/button";
import { WithTooltip } from "@/web/components/with-tooltip";

// How long a call runs before it can be moved.
const MOMENT_MS = 2000;

export interface ActivityActions {
  // Moves the call with the id to the background.
  move: (callId: string) => Promise<void>;
  // Stops the call with the id.
  cancel: (callId: string) => Promise<void>;
  // Pauses, resumes and deletes a timer or schedule by its id.
  schedule: {
    pause: (id: string) => Promise<void>;
    resume: (id: string) => Promise<void>;
    remove: (id: string) => Promise<void>;
  };
  // Pauses, resumes and deletes a webhook by its id.
  webhook: {
    pause: (id: string) => Promise<void>;
    resume: (id: string) => Promise<void>;
    remove: (id: string) => Promise<void>;
    // Sets its signing secret, or clears it with null.
    secret: (id: string, secret: string | null) => Promise<void>;
    // Names the header its deliveries carry their id in, or clears it with null.
    deliveryHeader: (id: string, header: string | null) => Promise<void>;
  };
}

export const ActivityActionsContext = createContext<ActivityActions | null>(null);

export function useActivityActions() {
  return useContext(ActivityActionsContext);
}

// Whether the moment has passed since the call was asked for.
function useRunningFor(since: string) {
  const remaining = () => Math.max(0, MOMENT_MS - (Date.now() - new Date(since).getTime()));
  const [waited, setWaited] = useState(() => remaining() === 0);
  useEffect(() => {
    if (waited) return;
    const timer = setTimeout(() => setWaited(true), remaining());
    return () => clearTimeout(timer);
  });
  return waited;
}

export function MoveToBackground({ row }: { row: ToolRow }) {
  const actions = useActivityActions();
  const waited = useRunningFor(row.requestedAt);
  const [moving, setMoving] = useState(false);
  if (!actions || !row.canBackground || !waited) return null;
  return (
    <WithTooltip label="Move to background">
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Move to background"
        disabled={moving}
        onClick={() => {
          setMoving(true);
          void actions.move(row.id).finally(() => setMoving(false));
        }}
      >
        <ArrowDownToLineIcon />
      </Button>
    </WithTooltip>
  );
}

// Stops a call that runs in the background, where the reader may.
export function CancelJob({ row }: { row: ToolRow }) {
  const actions = useActivityActions();
  const [stopping, setStopping] = useState(false);
  if (!actions || !row.work?.canCancel) return null;
  return (
    <WithTooltip label="Cancel">
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Cancel"
        disabled={stopping}
        onClick={() => {
          setStopping(true);
          void actions.cancel(row.id).finally(() => setStopping(false));
        }}
      >
        <SquareIcon className="size-3 fill-current" />
      </Button>
    </WithTooltip>
  );
}
