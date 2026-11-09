// How each row of a thread's transcript looks: a person's message, an agent's turn of tool calls
// and its reply under one Agent header, a failed or stopped run, where the thread was compacted,
// where a forked thread's copy ends with a link back, where a restored branch goes on with the
// versions of what came after, and a labelled placeholder for an event this client does not know
// yet.

import { FORMER_TOOL_IDS, type ToolDefinition } from "@/shared/tools.ts";
import { Time } from "@/web/components/time";
import { AgentReply } from "@/web/threads/transcript/agent-reply";
import { CompactionDivider } from "@/web/threads/transcript/compaction-divider";
import type { OwnRow } from "@/web/threads/transcript/entries";
import { FailureNotice } from "@/web/threads/transcript/failure-notice";
import { HumanMessage } from "@/web/threads/transcript/human-message";
import { RetryButton } from "@/web/threads/transcript/retry-button";
import type { RowActions } from "@/web/threads/transcript/row-actions";
import { VersionSwitcher } from "@/web/threads/transcript/row-history";
import { RowLink } from "@/web/threads/transcript/row-focus";
import { ToolCall } from "@/web/threads/transcript/tool-call";

export function TranscriptItem({
  row,
  actions = {},
  tools = [],
}: {
  row: OwnRow;
  actions?: RowActions;
  // The tools' definitions, by which their calls' input and output show, those made under a
  // tool's former id too.
  tools?: ToolDefinition[];
}) {
  switch (row.kind) {
    case "human":
      return <HumanMessage row={row} onEdit={actions.edit} />;
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
    case "limit":
      return (
        <p role="status" className="text-center text-xs text-muted-foreground">
          Subagents sent each other {row.limit} messages; more are refused
          {row.sentBy && (
            <>
              {" · "}
              <RowLink
                threadId={row.sentBy.threadId}
                rowId={row.sentBy.rowId}
                className="font-medium text-foreground underline-offset-2 hover:underline"
              >
                {[row.sentBy.toolset, row.sentBy.title].filter(Boolean).join(" › ")}
              </RowLink>{" "}
              in {row.sentBy.thread}
            </>
          )}
        </p>
      );
    case "fork": {
      const what = row.summary ? "Started from a summary of" : "Forked from";
      const by = row.by ? ` by ${row.by.name}` : "";
      return (
        <p role="status" className="text-center text-xs text-muted-foreground">
          {what}{" "}
          {row.linked ? (
            <RowLink
              threadId={row.from.threadId}
              rowId={row.from.rowId}
              className="font-medium text-foreground underline-offset-2 hover:underline"
            >
              {row.from.title}
            </RowLink>
          ) : (
            <span className="font-medium">{row.from.title}</span>
          )}
          {by}
        </p>
      );
    }
    case "restore":
      return (
        <div
          role="status"
          aria-label="Restored"
          className="flex items-center gap-3 text-xs text-muted-foreground"
        >
          <span aria-hidden className="h-px flex-1 bg-border" />
          <span>
            Restored from here{row.by && ` by ${row.by.name}`} · <Time iso={row.postedAt} />
          </span>
          {row.versions && <VersionSwitcher versions={row.versions} />}
          <span aria-hidden className="h-px flex-1 bg-border" />
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
