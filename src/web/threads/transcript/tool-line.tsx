// A tool call as one line with the tool and what became of the call, which opens on its input and
// output.

import { cn } from "cn";
import {
  CheckIcon,
  ChevronRightIcon,
  SkipForwardIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode } from "react";

import type { ToolDefinition } from "@/shared/tools.ts";
import type { ToolRow } from "@/shared/transcript.ts";
import { callResultOf } from "@/web/agent/tool-layout";
import { ToolInput, ToolResult } from "@/web/agent/tool-value";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/web/components/ui/collapsible";
import { Spinner } from "@/web/components/ui/spinner";
import { GIVES_WAY, ToolCrumb, toolPath } from "@/web/threads/transcript/tool-crumb";

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
  // What became of the call follows the tool, item by item, with whose own credentials it ran.
  const outcome = [status, who, row.ranAs && `as ${row.ranAs.name}`].filter(Boolean).join(" · ");
  const took = duration(row.ms);
  return (
    <Collapsible className={cn("text-xs text-muted-foreground", !framed && "pl-9")}>
      <CollapsibleTrigger
        aria-label={`${toolPath(row, definition)} · ${outcome}`}
        className="group/tool flex w-full items-center gap-1.5 rounded-md py-0.5 text-left hover:text-foreground [&>svg]:size-3.5 [&>svg]:shrink-0"
      >
        <ChevronRightIcon className="transition-transform group-data-[panel-open]/tool:rotate-90" />
        {icon}
        <span className="flex min-w-0 flex-1 items-center gap-1">
          <ToolCrumb row={row} definition={definition} className="font-medium" />
          <span className={GIVES_WAY}>· {outcome}</span>
        </span>
        {took && <span className="shrink-0 tabular-nums">{took}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 flex flex-col gap-3 rounded-md bg-muted px-3 py-2">
        <ToolInput value={row.input} schema={definition?.inputSchema} />
        {row.output && (
          <ToolResult result={callResultOf(row.output)} schema={definition?.outputSchema} />
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
