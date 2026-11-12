// The header of a card about a change someone made, told from its parts: what it was made to and
// what was done, so a reader scans it instead of reading a sentence.

import { cn } from "cn";
import { ArrowRightIcon, ShieldCheckIcon, ShieldOffIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { Change } from "@/shared/threads/events.ts";
import type { TaskStatus } from "@/shared/tasks.ts";
import { Badge } from "@/web/components/ui/badge";
import { STATUS_ICONS, STATUS_LABELS, STATUS_TINTS } from "@/web/threads/task-list";
import { Crumb } from "@/web/threads/transcript/tool-crumb";

// What each action without values of its own is called on its chip.
const VERBS: Partial<Record<Change["action"], string>> = {
  add: "Added",
  remove: "Removed",
  archive: "Archived",
  pause: "Paused",
  resume: "Resumed",
  delete: "Deleted",
};

const isStatus = (value: string | undefined): value is TaskStatus =>
  value !== undefined && value in STATUS_ICONS;

function Status({ status, label }: { status: TaskStatus; label?: boolean }) {
  const Icon = STATUS_ICONS[status];
  return (
    <span className={cn("flex shrink-0 items-center gap-1 text-xs", STATUS_TINTS[status])}>
      <Icon aria-hidden className="size-3.5" />
      {label && STATUS_LABELS[status]}
    </span>
  );
}

function Arrow() {
  return <ArrowRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />;
}

export function ChangeTitle({ change, parent }: { change: Change; parent?: ReactNode }) {
  const { subject, action, from, to } = change;
  const name = <span className="min-w-0 truncate">{subject.name}</span>;
  let rest: ReactNode;
  if (action === "status" && isStatus(to)) {
    rest = (
      <>
        {name}
        {isStatus(from) && <Status status={from} />}
        {isStatus(from) && <Arrow />}
        <Status status={to} label />
      </>
    );
  } else if (action === "rename" && from) {
    rest = (
      <>
        <span className="min-w-0 truncate text-muted-foreground">{from}</span>
        <Arrow />
        <span className="min-w-0 truncate">{subject.name}</span>
      </>
    );
  } else if (action === "assign" && to) {
    rest = (
      <>
        {name}
        <Badge variant="secondary" className="shrink-0">
          For {to}
        </Badge>
      </>
    );
  } else if (action === "signature") {
    const Icon = to === "off" ? ShieldOffIcon : ShieldCheckIcon;
    rest = (
      <>
        {name}
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <Icon aria-hidden className="size-3.5" />
          Signature {to === "off" ? "off" : "on"}
        </span>
      </>
    );
  } else if (action === "model") {
    rest = (
      <>
        <span className="min-w-0 truncate text-muted-foreground">{from ?? "Default"}</span>
        <Arrow />
        <span className="min-w-0 truncate">{to ?? "Default"}</span>
      </>
    );
  } else {
    rest = (
      <>
        {name}
        {VERBS[action] && (
          <Badge variant="secondary" className="shrink-0">
            {VERBS[action]}
          </Badge>
        )}
      </>
    );
  }
  return (
    <Crumb parent={parent}>
      <span className="flex min-w-0 items-center gap-1.5">{rest}</span>
    </Crumb>
  );
}
