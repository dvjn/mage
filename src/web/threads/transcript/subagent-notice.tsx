// Subagents that ended runs, told together in one line of the agent's like a tool call's: how many,
// where they stand and which. It opens on a line for each, with the last thing it said and a way to
// open its thread, and that opens on all of what it said.

import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { BotIcon, ChevronRightIcon } from "lucide-react";

import type { NoticeRow } from "@/shared/threads/rows.ts";
import { MessageResponse } from "@/web/components/ai-elements/message";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/web/components/ui/collapsible";

const LINE =
  "flex w-full min-w-0 items-center gap-1.5 rounded-md py-0.5 text-left hover:text-foreground [&>svg]:size-3.5 [&>svg]:shrink-0";

// What the subagents' states read as together.
function stateOf(subagents: NoticeRow["subagents"]) {
  const states = new Set(subagents.map((subagent) => subagent.state));
  return states.size === 1 ? [...states][0]! : "done";
}

export function SubagentNotice({ row }: { row: NoticeRow }) {
  const { subagents } = row;
  const mixed = new Set(subagents.map((subagent) => subagent.state)).size > 1;
  const count = subagents.length === 1 ? "1 subagent" : `${subagents.length} subagents`;
  const nameOf = (subagent: NoticeRow["subagents"][number]) =>
    mixed ? `${subagent.name} (${subagent.state})` : subagent.name;
  const names = subagents.map(nameOf).join(", ");
  return (
    <Collapsible
      role="status"
      aria-label="Subagents"
      className="pl-9 text-xs text-muted-foreground"
    >
      <CollapsibleTrigger
        aria-label={`${count} ${stateOf(subagents)} · ${names}`}
        className={cn("group/notice", LINE)}
      >
        <ChevronRightIcon className="transition-transform group-data-[panel-open]/notice:rotate-90" />
        <BotIcon />
        <span className="flex min-w-0 flex-1 items-center gap-1">
          <span className="shrink-0 font-medium">
            {count} {stateOf(subagents)}
          </span>
          <span className="min-w-0 truncate">· {names}</span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 flex flex-col gap-1 pl-5">
        {subagents.map((subagent) => (
          <Collapsible key={subagent.threadId}>
            <div className="flex items-center gap-2">
              <CollapsibleTrigger
                aria-label={nameOf(subagent)}
                disabled={!subagent.last}
                className={cn("group/subagent", LINE)}
              >
                <ChevronRightIcon className="transition-transform group-data-[panel-open]/subagent:rotate-90" />
                <BotIcon />
                <span className="flex min-w-0 flex-1 items-center gap-1">
                  <span className="shrink-0 font-medium">{nameOf(subagent)}</span>
                  {subagent.last && (
                    <span className="min-w-0 truncate">· {subagent.last.split("\n")[0]}</span>
                  )}
                </span>
              </CollapsibleTrigger>
              <Link
                to="/t/$threadId"
                params={{ threadId: subagent.threadId }}
                aria-label={`Open ${subagent.name}`}
                className="shrink-0 rounded-md px-1.5 py-0.5 font-medium text-foreground hover:bg-muted"
              >
                Open
              </Link>
            </div>
            <CollapsibleContent className="mt-1 pl-5 text-sm text-foreground">
              <MessageResponse>{subagent.last}</MessageResponse>
            </CollapsibleContent>
          </Collapsible>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}
