// How each row of a thread's transcript looks: a person's message, an agent's turn of tool calls and
// its reply under one Agent header, a failed or stopped run, where the thread was compacted, and a
// labelled placeholder for an event this client does not know yet.

import type { ShownRow } from "@/shared/threads/rows.ts";
import { FORMER_TOOL_IDS, type ToolDefinition } from "@/shared/tools.ts";
import { AgentReply } from "@/web/threads/transcript/agent-reply";
import { CompactionDivider } from "@/web/threads/transcript/compaction-divider";
import { FailureNotice } from "@/web/threads/transcript/failure-notice";
import { HumanMessage } from "@/web/threads/transcript/human-message";
import { RetryButton } from "@/web/threads/transcript/retry-button";
import type { RowActions } from "@/web/threads/transcript/row-actions";
import { ToolCall } from "@/web/threads/transcript/tool-call";

export function TranscriptItem({
  row,
  actions = {},
  tools = [],
}: {
  row: ShownRow;
  actions?: RowActions;
  // The tools' definitions, by which their calls' input and output show, those made under a
  // tool's former id too.
  tools?: ToolDefinition[];
}) {
  switch (row.kind) {
    case "human":
      return <HumanMessage row={row} />;
    case "agent":
      // A step that only called tools shows as its calls.
      if (!row.turn) return null;
      return <AgentReply row={row} continued={row.turn.continued} />;
    case "tool":
      return (
        <ToolCall
          row={row}
          definition={tools.find(
            (tool) => tool.name === (FORMER_TOOL_IDS[row.toolId] ?? row.toolId),
          )}
          decide={actions.decide}
          answer={actions.answer}
          turn={row.turn ?? { continued: false, model: null }}
        />
      );
    case "failure":
      return <FailureNotice row={row} actions={actions} />;
    case "stop":
      return (
        <div role="status" className="flex items-center justify-center gap-2">
          <p className="text-xs text-muted-foreground">
            {row.by ? `${row.by} stopped the agent` : "The agent was stopped"}
          </p>
          {actions.retry && <RetryButton onRetry={actions.retry} />}
        </div>
      );
    case "compaction":
      return <CompactionDivider row={row} />;
    case "unknown":
      return (
        <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          Unsupported event: {row.type}
        </div>
      );
  }
}
