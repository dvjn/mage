// What a tool is called, as the server names it, as a breadcrumb: its toolset or MCP server in
// muted text that lights up with the line on hover, a chevron, and the tool's own name.

import { cn } from "cn";
import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { ToolRow } from "@/shared/threads/rows.ts";
import { useModelNamer } from "@/web/threads/transcript/agent";

// A call as the line names it: its tool's title, then for loading a skill the skill, and for
// starting a subagent its name and the model it runs with; else its input in a few words, where
// the server says it.
function useCallTitle() {
  const nameOf = useModelNamer();
  return (row: ToolRow) => {
    if (row.skill) return `${row.state === "completed" ? "Loaded" : "Load"} ${row.skill}`;
    if (row.subagentName) {
      return [row.title, row.subagentName, nameOf(row.model ?? null)].filter(Boolean).join(" · ");
    }
    return [row.title, row.summary].filter(Boolean).join(" · ");
  };
}

// What goes before a call's own name: the call that made it, where another did, and its tool's
// server.
function parentOf(row: ToolRow) {
  return [row.parent?.title, row.toolset].filter(Boolean).join(" › ") || undefined;
}

// What a tool is called, in words: its server's name before its own where it has a server.
export function useToolPath() {
  const titleOf = useCallTitle();
  return (row: ToolRow) => [parentOf(row), titleOf(row)].filter(Boolean).join(" › ");
}

// An item of a flex row that grows from nothing into the room its siblings leave, up to its own
// width, so that it truncates before they do.
export const GIVES_WAY = "min-w-0 max-w-max flex-1 truncate";

// A breadcrumb inside a flex row: the parent in muted text and a chevron before the name where
// there is one. Where the row is short, the parent truncates first, sharing the room the name
// leaves with any other item of the row that gives way the same, and the name only once the
// parent is gone. The name takes the class given.
export function Crumb({
  parent,
  children,
  className,
}: {
  parent?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <>
      {parent && (
        <>
          <span className={cn(GIVES_WAY, "text-muted-foreground group-hover/tool:text-foreground")}>
            {parent}
          </span>
          <ChevronRightIcon
            aria-hidden
            className="size-3 shrink-0 text-muted-foreground group-hover/tool:text-foreground"
          />
        </>
      )}
      <span className={cn("min-w-0 truncate", className)}>{children}</span>
    </>
  );
}

// What a tool is called, as a breadcrumb: its server's name before its own where it has a server.
export function ToolCrumb({ row, className }: { row: ToolRow; className?: string }) {
  const titleOf = useCallTitle();
  return (
    <Crumb parent={parentOf(row)} className={className}>
      {titleOf(row)}
    </Crumb>
  );
}
