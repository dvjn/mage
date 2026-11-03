// What a tool is called, as the server names it, as a breadcrumb: its toolset or MCP server in
// muted text that lights up with the line on hover, a chevron, and the tool's own name.

import { cn } from "cn";
import { ChevronRightIcon } from "lucide-react";

import type { ToolRow } from "@/shared/threads/rows.ts";

// What a tool is called, in words: its server's name before its own where it has a server.
export function toolPath(row: ToolRow) {
  return [row.toolset, row.title].filter(Boolean).join(" › ");
}

// An item of a flex row that grows from nothing into the room its siblings leave, up to its own
// width, so that it truncates before they do.
export const GIVES_WAY = "min-w-0 max-w-max flex-1 truncate";

// What a tool is called, as a breadcrumb inside a flex row: its server's name in muted text and a
// chevron before its own where it has a server. Where the row is short, the server's name truncates
// first, sharing the room the tool's name leaves with any other item of the row that gives way the
// same, and the tool's own name only once the server's is gone. It takes the class given.
export function ToolCrumb({ row, className }: { row: ToolRow; className?: string }) {
  return (
    <>
      {row.toolset && (
        <>
          <span className={cn(GIVES_WAY, "text-muted-foreground group-hover/tool:text-foreground")}>
            {row.toolset}
          </span>
          <ChevronRightIcon
            aria-hidden
            className="size-3 shrink-0 text-muted-foreground group-hover/tool:text-foreground"
          />
        </>
      )}
      <span className={cn("min-w-0 truncate", className)}>{row.title}</span>
    </>
  );
}
