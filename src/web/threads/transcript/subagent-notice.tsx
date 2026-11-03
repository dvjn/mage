// Subagents that ended runs, told together in one compact row: how many and where they stand, then
// each by label, opening its thread, with the last thing it said.

import { Link } from "@tanstack/react-router";
import { Fragment } from "react";

import type { NoticeRow } from "@/shared/threads/rows.ts";

// What the subagents' states read as together.
function stateOf(subagents: NoticeRow["subagents"]) {
  const states = new Set(subagents.map((subagent) => subagent.state));
  return states.size === 1 ? [...states][0]! : "done";
}

export function SubagentNotice({ row }: { row: NoticeRow }) {
  const { subagents } = row;
  const mixed = new Set(subagents.map((subagent) => subagent.state)).size > 1;
  const count = subagents.length === 1 ? "1 subagent" : `${subagents.length} subagents`;
  return (
    <div
      role="status"
      aria-label="Subagents"
      className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-xs text-muted-foreground"
    >
      <span className="shrink-0 font-medium">
        {count} {stateOf(subagents)}
      </span>
      {subagents.map((subagent) => (
        <Fragment key={subagent.threadId}>
          <span aria-hidden>·</span>
          <span className="min-w-0 truncate">
            <Link
              to="/t/$threadId"
              params={{ threadId: subagent.threadId }}
              className="font-medium text-foreground underline-offset-2 hover:underline"
            >
              {subagent.name}
            </Link>
            {mixed && ` (${subagent.state})`}
            {subagent.last && `: “${subagent.last}”`}
          </span>
        </Fragment>
      ))}
    </div>
  );
}
