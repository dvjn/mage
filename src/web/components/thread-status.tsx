// A thread's status for the signed-in person, as its row in a list shows it: a glyph of its own
// shape and colour (an amber spinner while the agent works, a green dot for something new, a red
// triangle when it failed, a blue hand while it waits for them, a softer blue hand while it waits
// for someone else), with what it means in words on hover and for screen readers, so the status
// never rests on colour alone; nothing while there is nothing new. The spinner holds still for
// those who ask for less motion.

import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { HandIcon, LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";

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

// How long ago, in whole minutes, as the tooltip says it.
function minutesSince(iso: string) {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  return minutes < 1 ? "just now" : `${minutes} min`;
}

// What the glyph means: the status's word, then what there is to say about it.
function tooltipOf(status: ThreadStatus, activity: ThreadActivity) {
  const run = activity.run;
  switch (status) {
    case "waiting":
      return `Waiting for you · since ${clock.format(new Date(run?.since ?? Date.now()))}`;
    case "paused":
      return "Paused · waiting for someone to approve";
    case "failed":
      return `Failed · ${activity.failed?.error || "The agent could not reply"}`;
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
      return <HandIcon className="size-4 shrink-0 text-status-waiting" />;
    case "paused":
      return <HandIcon className="size-4 shrink-0 text-status-paused" />;
    case "failed":
      return <TriangleAlertIcon className="size-4 shrink-0 text-status-failed" />;
    case "working":
      return (
        <LoaderCircleIcon className="size-4 shrink-0 text-status-working motion-safe:animate-spin" />
      );
    case "unread":
      return (
        <span className="grid size-4 shrink-0 place-items-center">
          <span className="size-2 rounded-full bg-status-unread" />
        </span>
      );
    case "read":
      return null;
  }
}

// The status's glyph, named for screen readers, with what it means on hover; nothing for a thread
// with nothing new.
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
  if (!tooltip) return null;
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
