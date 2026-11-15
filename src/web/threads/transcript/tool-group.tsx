// A run of the agent's tool calls folded into one line: how many calls, the toolsets they came
// from and what did not run, and how many messages the subagents they started sent each other, and
// the state that needs most notice: a call waiting for a decision, then one running. It opens on
// who sent those messages to whom, and the calls' own lines and the thinking between them.

import { cn } from "cn";
import { CheckIcon, ChevronRightIcon, HandIcon, SkipForwardIcon, XIcon } from "lucide-react";

import type { AgentRow, AgentTurn, ToolRow } from "@/shared/threads/rows.ts";
import { FORMER_TOOL_IDS, type ToolDefinition } from "@/shared/tools.ts";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/web/components/ui/collapsible";
import { Spinner } from "@/web/components/ui/spinner";
import { useThreadAgent } from "@/web/threads/transcript/agent";
import { ReplyReasoning } from "@/web/threads/transcript/agent-reply";
import { TranscriptRowFrame } from "@/web/threads/transcript/row-frame";
import { MoveToBackground } from "@/web/threads/transcript/activity-actions";
import { ToolCall } from "@/web/threads/transcript/tool-call";
import { GIVES_WAY } from "@/web/threads/transcript/tool-crumb";

// What the calls that did not run are counted as, in this order.
const MISSES: [string, ToolRow["state"][]][] = [
  ["failed", ["failed"]],
  ["denied", ["denied", "stale"]],
  ["stopped", ["cancelled"]],
  ["skipped", ["skipped"]],
];

// The states of a call that did not run as asked.
const FAILED: ToolRow["state"][] = ["failed", "denied", "stale", "cancelled"];

// A call that waits for a decision, and one that is running.
const waits = (call: ToolRow) => call.state === "waiting";
const running = (call: ToolRow) => call.state === "ready";

// The run in words: how many calls, their toolsets in order, and how many of each that did not run.
export function callsSummary(calls: ToolRow[]) {
  const toolsets = [...new Set(calls.map((call) => call.toolset).filter(Boolean))].join(", ");
  const misses = MISSES.map(([label, states]) => {
    const count = calls.filter((call) => states.includes(call.state)).length;
    return count > 0 ? `${count} ${label}` : null;
  }).filter((miss) => miss !== null);
  return { count: `${calls.length} tool calls`, toolsets, misses };
}

export function ToolGroup({
  rows,
  calls,
  turn,
  tools,
  open,
  onOpenChange,
}: {
  rows: (ToolRow | AgentRow)[];
  calls: ToolRow[];
  turn: AgentTurn;
  tools: ToolDefinition[];
  // Held by the page, so that it stays as the run grows or earlier rows are read.
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { self } = useThreadAgent();
  // The most urgent state a call is in: waiting for a decision, then running, then failed.
  const waiting = calls.some(waits);
  const current = waiting ? undefined : calls.findLast(running);
  const { count, toolsets, misses } = callsSummary(calls);
  const failed = calls.some((call) => FAILED.includes(call.state));
  const skipped = calls.some((call) => call.state === "skipped");
  const status = waiting ? "Waiting for approval" : current ? "Running" : null;
  const label = [count, toolsets, status, ...misses].filter(Boolean).join(" · ");
  const group = (
    <Collapsible open={open} onOpenChange={onOpenChange} className="text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <CollapsibleTrigger
          aria-label={label}
          className="group/tool flex w-full items-center gap-1.5 rounded-md py-0.5 text-left hover:text-foreground [&>svg]:size-3.5 [&>svg]:shrink-0"
        >
          <ChevronRightIcon className="transition-transform group-data-[panel-open]/tool:rotate-90" />
          {waiting ? (
            <HandIcon className="text-warning" />
          ) : current ? (
            <Spinner />
          ) : failed ? (
            <XIcon />
          ) : skipped ? (
            <SkipForwardIcon />
          ) : (
            <CheckIcon className="text-foreground" />
          )}
          <span className="flex min-w-0 flex-1 items-center gap-1">
            <span className="shrink-0 font-medium">{count}</span>
            {toolsets && <span className={GIVES_WAY}>· {toolsets}</span>}
            {status && (
              <span className={cn("shrink-0", waiting && "text-warning")}>· {status}</span>
            )}
            {misses.length > 0 && <span className="shrink-0">· {misses.join(" · ")}</span>}
          </span>
        </CollapsibleTrigger>
        {current && <MoveToBackground row={current} />}
      </div>
      <CollapsibleContent className="mt-1 flex flex-col gap-1 pl-5">
        {rows.map((row) =>
          row.kind === "tool" ? (
            <ToolCall
              key={row.id}
              row={row}
              definition={tools.find(
                (tool) => tool.name === (FORMER_TOOL_IDS[row.toolId] ?? row.toolId),
              )}
              turn={row.turn ?? turn}
              framed
            />
          ) : (
            <ReplyReasoning key={row.id} row={row} />
          ),
        )}
      </CollapsibleContent>
    </Collapsible>
  );
  if (turn.continued) return group;
  return (
    <TranscriptRowFrame
      author={self.name}
      at={calls[0]!.requestedAt}
      label={`Message from ${self.name}`}
    >
      {group}
    </TranscriptRowFrame>
  );
}
