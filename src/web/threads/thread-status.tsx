// A thread's status for the signed-in person, as its row in a list shows it: a glyph of its own
// shape and colour (an amber spinner while the agent works, a dot in the text's colour for something
// new, a red triangle when it failed, a blue hand while it waits for them, a softer blue hand while
// it waits for someone else), at the size a list asks for, with what it means in words on hover and
// for screen readers, so the status never rests on colour alone; nothing while there is nothing
// new. The spinner holds still for those who ask for less motion. A one-line row shows the status
// as a dot on its model's mark instead. A small dot in the waiting colour says a folder holds a
// thread that needs them.

import { cn } from "cn";
import { HandIcon, LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";

import { ASK_TOOL } from "@/shared/ask.ts";
import type { ThreadStatus } from "@/shared/thread-status.ts";
import type { ThreadActivity } from "@/shared/threads/list.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/web/components/ui/tooltip";
import { useMinute } from "@/web/hooks/use-minute";

const clock = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

// How long ago, in whole minutes, as the tooltip says it.
function minutesSince(iso: string) {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  return minutes < 1 ? "just now" : `${minutes} min`;
}

// What the glyph means: the status's word, then what there is to say about it; nothing for read.
function tooltipOf(status: ThreadStatus, activity: ThreadActivity) {
  const run = activity.run;
  switch (status) {
    case "waiting":
      return `Waiting for you · since ${clock.format(new Date(run?.since ?? Date.now()))}`;
    case "paused":
      return run?.toolId === ASK_TOOL
        ? "Paused · waiting for someone to answer"
        : "Paused · waiting for someone to approve";
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

// The glyph in a box of the size given, as a class; the dot keeps its own size in any box.
function Glyph({ status, size }: { status: ThreadStatus; size: string }) {
  const box = cn(size, "shrink-0");
  switch (status) {
    case "waiting":
      return <HandIcon className={cn(box, "text-status-waiting")} />;
    case "paused":
      return <HandIcon className={cn(box, "text-status-paused")} />;
    case "failed":
      return <TriangleAlertIcon className={cn(box, "text-status-failed")} />;
    case "working":
      return (
        <LoaderCircleIcon className={cn(box, "text-status-working motion-safe:animate-spin")} />
      );
    case "unread":
      return (
        <span className={cn(box, "grid place-items-center")}>
          <span className="size-2.5 rounded-full bg-status-unread" />
        </span>
      );
    case "read":
      return null;
  }
}

// What the status means in words, kept current; null for read.
export function useStatusLabel(status: ThreadStatus, activity: ThreadActivity) {
  useMinute();
  return tooltipOf(status, activity);
}

// The status as a dot for the corner of a model's mark, on a disc of the row's colour, given as
// `--lead-bg`, so it reads on any row; named for screen readers. Working is a turning ring, still
// when less motion is asked for.
export function StatusDot({
  status,
  label,
  className,
}: {
  status: ThreadStatus;
  label: string | null;
  className?: string;
}) {
  if (status === "read" || !label) return null;
  const mark =
    status === "working"
      ? "size-2 border-[1.5px] border-status-working border-t-transparent motion-safe:animate-spin"
      : {
          waiting: "size-2 bg-status-waiting",
          paused: "size-2 bg-status-paused",
          failed: "size-2 bg-destructive",
          unread: "size-2 bg-status-unread",
        }[status];
  return (
    <span
      role="img"
      aria-label={label}
      className={cn(
        "flex size-3 items-center justify-center rounded-full bg-(--lead-bg,var(--sidebar))",
        className,
      )}
    >
      <span className={cn("block shrink-0 rounded-full", mark)} />
    </span>
  );
}

// The status's glyph, named for screen readers, with what it means on hover; nothing for a thread
// with nothing new.
export function StatusGlyph({
  status,
  activity,
  size = "size-4",
  className,
}: {
  status: ThreadStatus;
  activity: ThreadActivity;
  // The glyph's box, as a size class.
  size?: string;
  className?: string;
}) {
  useMinute();
  const tooltip = tooltipOf(status, activity);
  if (!tooltip) return null;
  const glyph = (
    <span role="img" aria-label={tooltip} className={cn("flex shrink-0", className)}>
      <Glyph status={status} size={size} />
    </span>
  );
  return (
    <Tooltip>
      <TooltipTrigger render={glyph} />
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

// The dot that says a folder holds a thread that needs the person.
export function NeedsYouDot({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="Needs you"
      className={cn("size-1.5 shrink-0 rounded-full bg-status-waiting", className)}
    />
  );
}
