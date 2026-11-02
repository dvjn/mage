// How each row of a thread's transcript looks: a person's message, an agent's turn of tool calls and
// its reply under one Agent header, a failed or stopped run, and a labelled placeholder for an event
// this client does not know yet.

import { FORMER_TOOL_IDS, type ToolConnection, type ToolDefinition } from "@/shared/tools.ts";
import type { AgentTurn, TranscriptRow } from "@/shared/transcript.ts";
import { AgentReply } from "@/web/threads/transcript/agent-reply";
import { FailureNotice } from "@/web/threads/transcript/failure-notice";
import { HumanMessage } from "@/web/threads/transcript/human-message";
import { RetryButton } from "@/web/threads/transcript/retry-button";
import type { RowActions } from "@/web/threads/transcript/row-actions";
import { ToolCall } from "@/web/threads/transcript/tool-call";

export function TranscriptItem({
  row,
  actions = {},
  tools = [],
  turn,
  connection,
}: {
  row: TranscriptRow;
  actions?: RowActions;
  // The tools' definitions, by which their calls show, those made under a tool's former id too.
  tools?: ToolDefinition[];
  // For a waiting call that would run with the reader's own credentials, their connection.
  connection?: ToolConnection;
  // Where the row sits in the agent's turn, for the agent's own rows.
  turn: AgentTurn | null;
}) {
  switch (row.kind) {
    case "human":
      return <HumanMessage row={row} />;
    case "agent":
      // A step that only called tools shows as its calls.
      if (!turn) return null;
      return <AgentReply row={row} continued={turn.continued} />;
    case "tool":
      return (
        <ToolCall
          row={row}
          definition={tools.find(
            (tool) => tool.name === (FORMER_TOOL_IDS[row.toolId] ?? row.toolId),
          )}
          decide={actions.decide}
          answer={actions.answer}
          connection={connection}
          turn={turn ?? { continued: false, model: null }}
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
    case "unknown":
      return (
        <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          Unsupported event: {row.type}
        </div>
      );
  }
}
