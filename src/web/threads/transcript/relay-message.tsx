// Another agent's message, folded into one line like a tool call's, naming who sent it and to whom:
// from a subagent, or from the agent that started this subagent. It opens on the message, with the
// call that sent it, or for older messages the thread an agent's message came from, and for the
// first, its task, what the subagent was set to do beside it. Messages in a row fold into one line
// of how many, from whom and to whom, which opens on theirs.

import { Link } from "@tanstack/react-router";
import { BotIcon, ChevronRightIcon } from "lucide-react";

import { cn } from "cn";

import { AGENT } from "@/shared/subagents.ts";
import type { RelayRow } from "@/shared/threads/rows.ts";
import { MessageResponse } from "@/web/components/ai-elements/message";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/web/components/ui/collapsible";
import { CopyButton } from "@/web/components/copy-button";
import { useThreadAgent } from "@/web/threads/transcript/agent";
import {
  relayRunKey,
  rowElementId,
  RowLink,
  useRowFocus,
} from "@/web/threads/transcript/row-focus";

// The line a message or a run of them folds into.
const LINE =
  "flex w-full min-w-0 items-center gap-1.5 rounded-md py-0.5 text-left hover:text-foreground [&>svg]:size-3.5 [&>svg]:shrink-0";

// Who sent a message and to whom, by the names they show as here.
function endsOf(row: RelayRow, agentName: string) {
  return {
    author: row.from.main ? agentName : row.from.name,
    to: row.to === AGENT ? agentName : row.to,
  };
}

// Which messages and runs the reader opened, held by the page so that they stay open as runs grow.
interface Opened {
  opened: ReadonlySet<string>;
  onOpenChange: (ids: string[], open: boolean) => void;
}

// What a run's line is held open by: any of its messages, so it stays as it grows from either end.
const runId = (row: RelayRow) => relayRunKey(row.id);

// Other agents' messages in a row, in the agent's line column: one as its line, more as one line
// that opens on theirs.
export function RelayMessages({ rows, opened, onOpenChange }: { rows: RelayRow[] } & Opened) {
  const { agentName } = useThreadAgent();
  const ends = rows.map((row) => endsOf(row, agentName));
  const authors = [...new Set(ends.map((end) => end.author))];
  const recipients = [...new Set(ends.map((end) => end.to))];
  const messages = rows.map((row) => (
    <RelayMessage
      key={row.id}
      row={row}
      open={opened.has(row.id)}
      onOpenChange={(open) => onOpenChange([row.id], open)}
    />
  ));
  if (rows.length === 1) return <div className="pl-9">{messages}</div>;
  const label = `${rows.length} messages · ${authors.join(", ")} → ${recipients.join(", ")}`;
  return (
    <Collapsible
      open={rows.some((row) => opened.has(runId(row)))}
      onOpenChange={(open) => onOpenChange(rows.map(runId), open)}
      className="pl-9 text-xs text-muted-foreground"
    >
      <CollapsibleTrigger aria-label={label} className={cn("group/relays", LINE)}>
        <ChevronRightIcon className="transition-transform group-data-[panel-open]/relays:rotate-90" />
        <BotIcon />
        <span className="flex min-w-0 flex-1 items-center gap-1">
          <span className="shrink-0 font-medium">{rows.length} messages</span>
          <span className="min-w-0 truncate">
            · {authors.join(", ")} → {recipients.join(", ")}
          </span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 flex flex-col gap-1 pl-5">{messages}</CollapsibleContent>
    </Collapsible>
  );
}

export function RelayMessage({
  row,
  open,
  onOpenChange,
}: {
  row: RelayRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { from, task, sentBy } = row;
  const { agentName } = useThreadAgent();
  const { author, to } = endsOf(row, agentName);
  const lit = useRowFocus()?.lit === row.id;
  return (
    <article
      id={rowElementId(row.id)}
      aria-label={`Message from ${author}`}
      data-lit={lit || undefined}
      className={cn(
        "rounded-md transition-colors duration-700",
        lit && "bg-accent ring-2 ring-ring/40",
      )}
    >
      <Collapsible
        open={open}
        onOpenChange={onOpenChange}
        className="text-xs text-muted-foreground"
      >
        <div className="flex items-center gap-2">
          <CollapsibleTrigger
            aria-label={`${author} → ${to}`}
            className={cn("group/relay min-w-0 flex-1", LINE)}
          >
            <ChevronRightIcon className="transition-transform group-data-[panel-open]/relay:rotate-90" />
            <BotIcon />
            <span className="min-w-0 truncate">
              <span className="font-medium">{author}</span> → {to}
            </span>
          </CollapsibleTrigger>
          {open && from.main && !sentBy && (
            <span className="shrink-0">
              from{" "}
              <Link
                to="/t/$threadId"
                params={{ threadId: from.threadId }}
                className="underline-offset-2 hover:underline"
              >
                {from.name}
              </Link>
            </span>
          )}
          {open && <CopyButton label="Copy message" value={row.text} className="shrink-0" />}
        </div>
        <CollapsibleContent className="mt-1 flex flex-col gap-2 pl-5">
          <div className="text-sm text-foreground">
            <MessageResponse>{row.text}</MessageResponse>
          </div>
          {task && (task.instructions || task.fork) && (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
              {task.instructions && (
                <>
                  <dt>Instructions</dt>
                  <dd className="whitespace-pre-wrap">{task.instructions}</dd>
                </>
              )}
              {task.fork && (
                <>
                  <dt>Context</dt>
                  <dd>A copy of {from.name}</dd>
                </>
              )}
            </dl>
          )}
          {sentBy && (
            <p>
              Sent by{" "}
              <RowLink
                threadId={sentBy.threadId}
                rowId={sentBy.rowId}
                className="font-medium text-foreground underline-offset-2 hover:underline"
              >
                {[sentBy.toolset, sentBy.title].filter(Boolean).join(" › ")}
              </RowLink>{" "}
              in {sentBy.thread}
            </p>
          )}
        </CollapsibleContent>
      </Collapsible>
    </article>
  );
}
