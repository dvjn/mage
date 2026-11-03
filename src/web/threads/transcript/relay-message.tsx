// Another agent's message, folded into one line like a tool call's, naming who sent it and to whom:
// from a subagent, or from the agent that started this subagent. It opens on the message, with the
// thread an agent's message came from, and for the first, its task, what the subagent was set to do
// beside it.

import { Link } from "@tanstack/react-router";
import { BotIcon, ChevronRightIcon } from "lucide-react";

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

export function RelayMessage({ row }: { row: RelayRow }) {
  const { from, task } = row;
  const { agentName } = useThreadAgent();
  const author = from.main ? agentName : from.name;
  const to = row.to === AGENT ? agentName : row.to;
  return (
    <article aria-label={`Message from ${author}`}>
      <Collapsible className="text-xs text-muted-foreground">
        <CollapsibleTrigger
          aria-label={`${author} → ${to}`}
          className="group/relay flex w-full min-w-0 items-center gap-1.5 rounded-md py-0.5 text-left hover:text-foreground [&>svg]:size-3.5 [&>svg]:shrink-0"
        >
          <ChevronRightIcon className="transition-transform group-data-[panel-open]/relay:rotate-90" />
          <BotIcon />
          <span className="min-w-0 truncate">
            <span className="font-medium">{author}</span> → {to}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-1 flex flex-col gap-2 pl-5">
          <div className="flex items-baseline gap-2">
            {from.main && (
              <span>
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
            <span className="ml-auto">
              <CopyButton label="Copy message" value={row.text} />
            </span>
          </div>
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
        </CollapsibleContent>
      </Collapsible>
    </article>
  );
}
