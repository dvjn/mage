// A tool call as one line with the tool and what became of the call, which opens on its input and
// output. A call that started a subagent says where the subagent stands now, with a way to open it.

import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import {
  CheckIcon,
  ChevronRightIcon,
  SkipForwardIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode } from "react";

import type { SubagentState } from "@/shared/subagents.ts";
import type { ToolDefinition } from "@/shared/tools.ts";
import type { ToolRow } from "@/shared/threads/rows.ts";
import { ToolInput, ToolOutput } from "@/web/agent/tool-value";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/web/components/ui/collapsible";
import { Spinner } from "@/web/components/ui/spinner";
import { GIVES_WAY, ToolCrumb, toolPath } from "@/web/threads/transcript/tool-crumb";

// Where a subagent stands, in words.
export const SUBAGENT_STATES: Record<SubagentState, string> = {
  queued: "Queued",
  working: "Working",
  idle: "Idle",
  stopped: "Stopped",
  archived: "Archived",
};

// What a working subagent waits on, in words.
export const SUBAGENT_NEEDS = { approval: "needs approval", answer: "asked a question" } as const;

// How long a call took to run, from a second on; nothing below that.
function duration(ms: number | null) {
  return ms !== null && ms >= 1000 ? `${Math.round(ms / 1000)}s` : null;
}

// A tool call that ran, is running or did not run, as one line with the tool's breadcrumb, what
// became of the call, who decided on it and whose credentials it ran with, which opens on its input
// and output.
export function ToolLine({
  row,
  definition,
  framed,
}: {
  row: ToolRow;
  definition: ToolDefinition | undefined;
  // Directly under an Agent header, rather than aligned with the text beside its avatar.
  framed?: boolean;
}) {
  const by = row.decision?.by.name;
  // Who let the call run, where someone did.
  const allowed =
    by && (row.decision?.scope === "for_now" ? `allowed for now by ${by}` : `allowed by ${by}`);
  let icon: ReactNode;
  let status: string;
  let who: string | undefined;
  switch (row.state) {
    case "ran":
      icon = <CheckIcon className="text-foreground" />;
      status = row.answers ? "Answered" : "Ran";
      who = row.answers ? by && `by ${by}` : allowed;
      break;
    case "failed":
      icon = <XIcon />;
      status = "Failed";
      who = allowed;
      break;
    case "denied":
      icon = <XIcon />;
      status = "Denied";
      who = by && `by ${by}`;
      break;
    case "stale":
      icon = <TriangleAlertIcon />;
      status = "Denied";
      who = "the approval no longer held";
      break;
    case "stopped":
      icon = <XIcon />;
      status = "Stopped";
      break;
    case "skipped":
      icon = <SkipForwardIcon />;
      status = "Skipped";
      who = by && `by ${by}`;
      break;
    default:
      icon = <Spinner />;
      status = row.waits && row.state === "pending" ? "Waiting" : "Running";
  }
  const { subagent } = row;
  if (subagent) {
    status = SUBAGENT_STATES[subagent.state];
    who = subagent.needs && SUBAGENT_NEEDS[subagent.needs];
    if (subagent.state === "working" || subagent.state === "queued") icon = <Spinner />;
  }
  // What became of the call follows the tool, item by item, with whose own credentials it ran.
  const outcome = [status, who, row.ranAs && `as ${row.ranAs.name}`].filter(Boolean).join(" · ");
  const took = duration(row.ms);
  const trigger = (
    <CollapsibleTrigger
      aria-label={`${toolPath(row)} · ${outcome}`}
      className="group/tool flex w-full min-w-0 items-center gap-1.5 rounded-md py-0.5 text-left hover:text-foreground [&>svg]:size-3.5 [&>svg]:shrink-0"
    >
      <ChevronRightIcon className="transition-transform group-data-[panel-open]/tool:rotate-90" />
      {icon}
      <span className="flex min-w-0 flex-1 items-center gap-1">
        <ToolCrumb row={row} className="font-medium" />
        <span className={GIVES_WAY}>· {outcome}</span>
      </span>
      {took && <span className="shrink-0 tabular-nums">{took}</span>}
    </CollapsibleTrigger>
  );
  return (
    <Collapsible className={cn("text-xs text-muted-foreground", !framed && "pl-9")}>
      {subagent ? (
        <div className="flex items-center gap-2">
          {trigger}
          <Link
            to="/t/$threadId"
            params={{ threadId: subagent.threadId }}
            aria-label={`Open ${subagent.name}`}
            className="shrink-0 rounded-md px-1.5 py-0.5 font-medium text-foreground hover:bg-muted"
          >
            Open
          </Link>
        </div>
      ) : (
        trigger
      )}
      <CollapsibleContent className="mt-1 flex flex-col gap-3 rounded-md bg-muted px-3 py-2">
        <ToolInput value={row.input} schema={definition?.inputSchema} />
        {row.output && <ToolOutput output={row.output} schema={definition?.outputSchema} />}
      </CollapsibleContent>
    </Collapsible>
  );
}
