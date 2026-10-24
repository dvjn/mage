// A thread's status for the signed-in person, as its row in a list shows it: a glyph in the row's
// icon slot with what it means on hover, and a short label for the row's muted line, so the status
// never rests on colour alone. The spinner holds still for those who ask for less motion.

import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { CircleAlertIcon, HandIcon, LoaderCircleIcon, MessageSquareIcon } from "lucide-react";

import { statusOf, type ThreadStatus } from "@/shared/thread-status.ts";
import type { ThreadActivity } from "@/shared/threads.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/web/components/ui/tooltip";
import { useMinute } from "@/web/hooks/use-minute";
import { meQuery } from "@/web/lib/queries";

const clock = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

// The thread's status for whoever is signed in; read until they are known.
export function useThreadStatus(activity: ThreadActivity): ThreadStatus {
  const me = useQuery(meQuery);
  return me.data ? statusOf(activity, me.data.user.id) : "read";
}

// The words the row's muted line starts with; none for a thread with nothing new.
export function statusLabel(status: ThreadStatus, activity: ThreadActivity) {
  switch (status) {
    case "waiting":
      return "Waiting for you";
    case "paused":
      return "Paused";
    case "failed":
      return "Failed";
    case "working":
      return activity.run?.status === "queued" ? "Queued" : "Working";
    case "unread":
      return "New";
    case "read":
      return null;
  }
}

// How long ago, in whole minutes, as the tooltip says it.
function minutesSince(iso: string) {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  return minutes < 1 ? "just now" : `${minutes} min`;
}

// What the glyph means, on hover.
function tooltipOf(status: ThreadStatus, activity: ThreadActivity) {
  const run = activity.run;
  switch (status) {
    case "waiting":
      return `Waiting for you · since ${clock.format(new Date(run?.since ?? Date.now()))}`;
    case "paused":
      return "Waiting for someone to approve";
    case "failed":
      return activity.failed?.error || "The agent could not reply";
    case "working":
      return run?.status === "queued" ? "Queued" : `Working · ${minutesSince(run?.since ?? "")}`;
    case "unread":
      return "New messages";
    case "read":
      return null;
  }
}

function Glyph({ status }: { status: ThreadStatus }) {
  switch (status) {
    case "waiting":
      return (
        <span className="grid size-4 shrink-0 place-items-center rounded-full bg-status-waiting">
          <HandIcon className="size-2.5! text-background" strokeWidth={2.5} />
        </span>
      );
    case "paused":
      return <HandIcon className="size-4 shrink-0 text-muted-foreground" />;
    case "failed":
      return <CircleAlertIcon className="size-4 shrink-0 text-destructive" />;
    case "working":
      return (
        <LoaderCircleIcon className="size-4 shrink-0 text-foreground/70 motion-safe:animate-spin" />
      );
    case "unread":
      return (
        <span className="grid size-4 shrink-0 place-items-center">
          <span className="size-2 rounded-full bg-primary" />
        </span>
      );
    case "read":
      return <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground" />;
  }
}

// The status's glyph, named for screen readers, with what it means on hover.
export function StatusGlyph({
  status,
  activity,
  className,
}: {
  status: ThreadStatus;
  activity: ThreadActivity;
  className?: string;
}) {
  useMinute();
  const tooltip = tooltipOf(status, activity);
  if (!tooltip) {
    return (
      <span aria-hidden className={cn("flex shrink-0", className)}>
        <Glyph status={status} />
      </span>
    );
  }
  const glyph = (
    <span role="img" aria-label={tooltip} className={cn("flex shrink-0", className)}>
      <Glyph status={status} />
    </span>
  );
  return (
    <Tooltip>
      <TooltipTrigger render={glyph} />
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
