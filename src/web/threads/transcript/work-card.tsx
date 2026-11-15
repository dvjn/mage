// A card for work that runs in the background, whatever kind: its kind and name, where it stands,
// how long it has run, a way to stop it while it runs, and a slot below for what its kind shows,
// such as a call's input and result. The kinds share this card; each fills the slot.

import { cn } from "cn";
import {
  BotIcon,
  CalendarClockIcon,
  CheckIcon,
  HandIcon,
  PauseIcon,
  PowerOffIcon,
  SquareIcon,
  WebhookIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { type WorkKind, type Work, type WorkStatus } from "@/shared/jobs.ts";
import { Alert } from "@/web/components/ui/alert";
import { Button } from "@/web/components/ui/button";
import { Spinner } from "@/web/components/ui/spinner";
import { WithTooltip } from "@/web/components/with-tooltip";

// What each kind of background work is called and shown with.
export const KINDS: Record<WorkKind, { label: string; icon: ReactNode }> = {
  job: { label: "Background call", icon: <WrenchIcon aria-hidden /> },
  schedule: { label: "Schedule", icon: <CalendarClockIcon aria-hidden /> },
  webhook: { label: "Webhook", icon: <WebhookIcon aria-hidden /> },
  subagent: { label: "Subagent", icon: <BotIcon aria-hidden /> },
  decision: { label: "Approval", icon: <HandIcon aria-hidden /> },
};

// The mark of work that waits for its time or its post, in place of the icon of its kind.
function StatusDot() {
  return <span aria-hidden className="mx-0.5 size-2 shrink-0 rounded-full bg-info" />;
}

// Where work stands, in words and with its mark.
export const STATUSES: Record<WorkStatus, { label: string; icon: ReactNode }> = {
  waiting: {
    label: "Waiting for approval",
    icon: <HandIcon aria-hidden className="text-warning" />,
  },
  running: { label: "Running", icon: <Spinner /> },
  completed: { label: "Done", icon: <CheckIcon aria-hidden className="text-foreground" /> },
  failed: { label: "Failed", icon: <XIcon aria-hidden /> },
  cancelled: { label: "Cancelled", icon: <SquareIcon aria-hidden /> },
  interrupted: { label: "Interrupted", icon: <PowerOffIcon aria-hidden /> },
  queued: { label: "Queued", icon: <Spinner /> },
  idle: { label: "Idle", icon: <CheckIcon aria-hidden className="text-foreground" /> },
  scheduled: { label: "Scheduled", icon: <StatusDot /> },
  listening: { label: "Listening", icon: <StatusDot /> },
  paused: { label: "Paused", icon: <PauseIcon aria-hidden /> },
};

// A schedule's own words for where it ends up: a timer that went off, and one that was deleted.
const SCHEDULE_ENDS: Partial<Record<WorkStatus, string>> = {
  completed: "Fired",
  cancelled: "Deleted",
};

// How long it ran, as short text: seconds, then minutes and seconds, then hours and minutes.
export function elapsedText(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// How long the work has run, counting while it does.
export function useElapsed({ startedAt, endedAt }: Pick<Work, "startedAt" | "endedAt">) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (endedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [endedAt]);
  if (!startedAt) return null;
  const end = endedAt ? new Date(endedAt).getTime() : now;
  return elapsedText(end - new Date(startedAt).getTime());
}

export function WorkCard({
  work,
  name,
  onCancel,
  actions,
  children,
}: {
  work: Work;
  // What the work is called, as its kind names it.
  name: ReactNode;
  // Stops it; given where the reader may.
  onCancel?: () => Promise<void>;
  // Controls of its own kind, in place of the stop button.
  actions?: ReactNode;
  // What its kind shows of it.
  children?: ReactNode;
}) {
  const kind = KINDS[work.kind];
  // A schedule or webhook has no run to time.
  const schedule = work.kind !== "job";
  const status = {
    ...STATUSES[work.status],
    ...(schedule && SCHEDULE_ENDS[work.status] && { label: SCHEDULE_ENDS[work.status]! }),
  };
  const elapsed = useElapsed(work);
  const [stopping, setStopping] = useState(false);
  const live =
    work.status === "running" ||
    work.status === "waiting" ||
    work.status === "scheduled" ||
    work.status === "listening" ||
    work.status === "paused";
  return (
    <Alert className={cn("flex flex-col gap-2.5 px-3 py-2.5", !live && "text-muted-foreground")}>
      <div className="flex min-w-0 items-center gap-2 text-xs [&>svg]:size-3.5 [&>svg]:shrink-0">
        {kind.icon}
        <span className="shrink-0 text-muted-foreground">{kind.label}</span>
        <span className="flex min-w-0 flex-1 items-center gap-1 text-sm text-foreground">
          {name}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 [&>svg]:size-3.5">
          {status.icon}
          {status.label}
        </span>
        {!schedule && <span className="shrink-0 tabular-nums">{elapsed}</span>}
        {actions}
        {onCancel && work.canCancel && (
          <WithTooltip label="Cancel">
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Cancel"
              disabled={stopping}
              onClick={() => {
                setStopping(true);
                void onCancel().finally(() => setStopping(false));
              }}
            >
              <SquareIcon className="size-3 fill-current" />
            </Button>
          </WithTooltip>
        )}
      </div>
      {children}
    </Alert>
  );
}
