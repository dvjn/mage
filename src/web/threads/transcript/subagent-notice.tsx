// Subagents that ended runs, told together in one line of the agent's like a tool call's: how many,
// where they stand and which. It opens on a line for each, with the last thing it said and a way to
// open its thread, and that opens on all of what it said.

import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { BellIcon, BotIcon, ChevronRightIcon } from "lucide-react";

import { ActivityNotice } from "@/web/threads/transcript/activity-notice";
import type { NoticeRow } from "@/shared/threads/rows.ts";
import { MessageResponse } from "@/web/components/ai-elements/message";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/web/components/ui/collapsible";
import { previewLine } from "@/shared/plain-text.ts";

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
  return (
    <ActivityNotice
      rowId={row.id}
      source={{ name: "Subagents", kind: "System", mark: <BellIcon /> }}
      title={
        <>
          {count} {stateOf(subagents)}
          {subagents.length > 0 && ": "}
          {subagents.map((subagent, index) => (
            <span key={subagent.threadId}>
              {index > 0 && ", "}
              <Link
                to="/t/$threadId"
                params={{ threadId: subagent.threadId }}
                className="font-medium underline-offset-2 hover:underline"
              >
                {nameOf(subagent)}
              </Link>
            </span>
          ))}
        </>
      }
      status="Subagents"
    >
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
                  <span className="min-w-0 truncate">· {previewLine(subagent.last)}</span>
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
    </ActivityNotice>
  );
}
