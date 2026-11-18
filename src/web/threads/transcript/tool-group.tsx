// A run of the agent's tool calls folded into one line: how many of the agent's own calls, the
// toolsets they came from and what did not run, a job judged by where it stands, and the state that
// needs most notice, of those calls and the calls under them: a call waiting for a decision, then
// one running. It opens on the calls' own lines and the thinking between them, and stays open while
// a call in it or under it waits for a decision.

import { cn } from "cn";
import { ChevronRightIcon } from "lucide-react";

import type { AgentRow, AgentTurn, ToolRow } from "@/shared/threads/rows.ts";
import type { ToolDefinition } from "@/shared/tools.ts";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/web/components/ui/collapsible";
import { useThreadAgent } from "@/web/threads/transcript/agent";
import { ReplyReasoning } from "@/web/threads/transcript/agent-reply";
import { missesOf } from "@/shared/call-outcome.ts";
import { runStanding } from "@/web/threads/transcript/call-tree";
import { TranscriptRowFrame } from "@/web/threads/transcript/row-frame";
import { MoveToBackground } from "@/web/threads/transcript/activity-actions";
import { ToolCall } from "@/web/threads/transcript/tool-call";
import { GIVES_WAY } from "@/web/threads/transcript/tool-crumb";
import { counted, definitionOf, StandingIcon } from "@/web/threads/transcript/tool-line";

export function ToolGroup({
  rows,
  calls,
  under,
  turn,
  tools,
  open,
  onOpenChange,
}: {
  rows: (ToolRow | AgentRow)[];
  calls: ToolRow[];
  // The calls under them at every depth.
  under: ToolRow[];
  turn: AgentTurn;
  tools: ToolDefinition[];
  // Held by the page, so that it stays as the run grows or earlier rows are read.
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { self } = useThreadAgent();
  const { standing, outcomes } = runStanding(calls, under);
  // The agent's own call running now, which may move to the background.
  const current = standing === "running" ? calls.findLast((call) => call.state === "ready") : null;
  const count = counted(calls.length, "tool call");
  const toolsets = [...new Set(calls.map((call) => call.toolset).filter(Boolean))].join(", ");
  const misses = missesOf(outcomes);
  const waiting = standing === "waiting";
  const status = waiting ? "Waiting for approval" : standing === "running" ? "Running" : null;
  const label = [count, toolsets, status, ...misses].filter(Boolean).join(" · ");
  const group = (
    <Collapsible
      open={open || waiting}
      onOpenChange={onOpenChange}
      className="text-xs text-muted-foreground"
    >
      <div className="flex items-center gap-2">
        <CollapsibleTrigger
          aria-label={label}
          className="group/tool flex w-full items-center gap-1.5 rounded-md py-0.5 text-left hover:text-foreground [&>svg]:size-3.5 [&>svg]:shrink-0"
        >
          <ChevronRightIcon className="transition-transform group-data-[panel-open]/tool:rotate-90" />
          <StandingIcon standing={standing} />
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
              definition={definitionOf(tools, row)}
              turn={row.turn ?? turn}
              framed
              under={under}
              tools={tools}
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
